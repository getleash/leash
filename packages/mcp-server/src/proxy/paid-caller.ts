import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  type MCPError,
  buildPaymentPayload,
  encodeRetryHeader,
  parseX402Challenge,
} from '@getleash/core';
import type { ToolContext } from '../tools/types.js';
import type { UpstreamAdapter } from '../upstreams/types.js';
import type { UpstreamClient } from './mcp-client.js';
import { signX402Payment } from './pay.js';
import { buildMcpError } from '../errors.js';
import { checkPolicy } from '../policy.js';
import { policyDenialToMcpError } from './policy-errors.js';

// ─── PaidToolCaller ──────────────────────────────────────────────────
//
// One instance per republished tool. Calls the upstream; on HTTP 402
// runs the x402 retry loop (parse challenge → policy-check → sign →
// retry → log). On success, returns the upstream response unchanged.
// On policy denial or upstream failure, returns an MCP-shaped error.
//
// The `meta.leash` field (authorization object reference) is embedded
// on every retry so counterparties can verify the agent was authorized
// without round-tripping through Leash.

export interface PaidCallerDeps {
  adapter: UpstreamAdapter;
  /** Transport-agnostic upstream client (MCP or REST synthesizer). */
  client: UpstreamClient;
  ctx: ToolContext;
}

export class PaidToolCaller {
  constructor(private readonly deps: PaidCallerDeps) {}

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { adapter, client, ctx } = this.deps;

    // 1. First attempt, no payment.
    let res = await client.callTool(toolName, args);
    if (res.status === 200) {
      return this.upstreamToCallResult(res.body);
    }
    if (res.status !== 402) {
      return this.upstreamUnavailable(
        adapter.name,
        `status ${res.status}: ${res.bodyText.slice(0, 200)}`,
      );
    }

    // 2. Parse challenge (header vs body by adapter declaration, but
    // @getleash/core's parser tolerates both).
    let challenge;
    try {
      challenge = parseX402Challenge({
        headers: res.headers,
        body: res.bodyText,
      });
    } catch (e) {
      return this.upstreamUnavailable(
        adapter.name,
        `402 but could not parse challenge: ${(e as Error).message}`,
      );
    }
    const chosen = challenge.accepts[0];
    const amount = BigInt(chosen.amount);

    // 3. Local policy check.
    const policy = checkPolicy({
      grant: ctx.runtime.signedGrant.grant,
      amount,
      target: {
        kind: 'x402',
        upstream: adapter.name,
        recipient: chosen.payTo,
      },
      db: ctx.db,
    });
    if (!policy.ok) {
      return policyDenialToMcpError(policy.denialCode, policy.details) as unknown as CallToolResult;
    }

    // 4. Sign.
    const sessionKey = ctx.sessionKeys.loadAgentKey(ctx.runtime.agentName);
    if (
      sessionKey.address.toLowerCase() !==
      ctx.runtime.signedGrant.grant.agent.toLowerCase()
    ) {
      return buildMcpError({
        code: 'SESSION_KEY_EXPIRED',
        category: 'auth',
        text: `Leash: session key on disk does not match the grant's registered agent.`,
        details: {
          on_disk: sessionKey.address,
          grant_agent: ctx.runtime.signedGrant.grant.agent,
        },
        suggested_action: `leash apply ${ctx.runtime.agentName}-policy.md`,
      }) as unknown as CallToolResult;
    }

    const signed = await signX402Payment({
      challenge,
      chosen,
      adapter,
      runtime: ctx.runtime,
      sessionKey,
    });

    // 5. Insert pending payment (budget now reserved).
    const paymentId = ctx.db.insertPayment({
      grantId: ctx.runtime.signedGrant.grant.id,
      kind: 'x402_payment',
      amount,
      recipient: chosen.payTo,
      upstream: adapter.name,
      authorizationDigest: signed.authorizationDigest,
      status: 'pending',
    });

    // Anything between here and a `confirmed`/`failed` status update is
    // wrapped — a thrown error must never leave the row as `pending` or
    // we silently inflate the budget counter for a call that never went
    // out the wire.
    try {
      // 6. Build retry payload (embeds meta.leash = authorization-object reference).
      const payload = buildPaymentPayload({
        challenge,
        chosen,
        signature: signed.signature,
        authorization: signed.authorization,
        leashMeta: {
          grantId: ctx.runtime.signedGrant.grant.id,
          grantRef: { inline: ctx.runtime.signedGrant },
        },
      });
      const header = encodeRetryHeader(payload);

      // 7. Retry with payment header.
      try {
        res = await client.callTool(toolName, args, { [header.name]: header.value });
      } catch (e) {
        ctx.db.failPayment({ id: paymentId, error: (e as Error).message });
        throw e;
      }
    } catch (e) {
      // Catch-all for the build/encode step too — they're pure but
      // surfacing them here keeps the payment ledger honest.
      ctx.db.failPayment({
        id: paymentId,
        error: `pre-retry error: ${(e as Error).message}`,
      });
      throw e;
    }

    if (res.status !== 200) {
      ctx.db.failPayment({
        id: paymentId,
        error: `retry status ${res.status}: ${res.bodyText.slice(0, 200)}`,
      });
      // Most common cause: facilitator rejected the authorization.
      return buildMcpError({
        code: 'FACILITATOR_REJECTED',
        category: 'upstream',
        text:
          `Leash: the payment was signed but the facilitator rejected it. ` +
          `Upstream returned ${res.status}. This can happen if the upstream's ` +
          `accepted asset or domain changes mid-flight. Re-run \`leash apply\` to refresh.`,
        details: {
          upstream: adapter.name,
          status: res.status,
          body: res.bodyText.slice(0, 200),
          authorization_digest: signed.authorizationDigest,
        },
        suggested_action: `leash apply ${ctx.runtime.agentName}-policy.md`,
      }) as unknown as CallToolResult;
    }

    // 8. Confirm — x402 payments don't expose a settlement tx hash to
    // the client; the authorization_digest is the proof of payment.
    ctx.db.confirmPayment({
      id: paymentId,
      // Zero sentinels: not every confirmation carries on-chain
      // visibility. The `kind='x402_payment'` row type makes this safe.
      txHash: ('0x' + '00'.repeat(32)) as `0x${string}`,
      blockNumber: 0n,
      gasUsed: 0n,
    });

    return this.upstreamToCallResult(res.body);
  }

  // ─── shape adapters ──────────────────────────────────────────────

  private upstreamToCallResult(body: unknown): CallToolResult {
    // MCP tools/call result shape: body.result is the CallToolResult.
    if (isObject(body) && isObject(body.result)) {
      return body.result as unknown as CallToolResult;
    }
    // Last-resort: wrap whatever we got as a text block.
    return {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
  }

  private upstreamUnavailable(upstream: string, detail: string): CallToolResult {
    return buildMcpError({
      code: 'UPSTREAM_UNAVAILABLE',
      category: 'upstream',
      text:
        `Leash: ${upstream} is not responding as expected. ${detail}. ` +
        `Try again in a few minutes.`,
      details: { upstream, detail },
      suggested_action: 'retry',
    }) as unknown as CallToolResult;
  }
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}
