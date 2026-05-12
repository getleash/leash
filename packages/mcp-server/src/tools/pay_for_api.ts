import {
  type Hex,
  type MCPError,
  parseX402Challenge,
  buildPaymentPayload,
  encodeRetryHeader,
} from '@getleash/core';
import type { ToolContext } from './types.js';
import { buildMcpError } from '../errors.js';
import { checkPolicy } from '../policy.js';
import { policyDenialToMcpError } from '../proxy/policy-errors.js';
import { getUpstreamAdapter } from '../upstreams/registry.js';
import { signX402Payment } from '../proxy/pay.js';

// ─── pay_for_api ─────────────────────────────────────────────────────
//
// Explicit-signing path. An agent that already has a 402 challenge
// (for instance, from a tool outside Leash's proxy layer) can bring
// it here: Leash policy-checks, signs via the session key, logs
// to SQLite, and returns the base64 retry-header the agent can send
// back to the upstream.
//
// Rarely needed in MVP — the proxy handles 402s automatically for
// republished upstream tools. This exists so agents can extend to
// upstreams outside Leash's curation without losing policy / audit.

export interface PayForApiInput {
  /** Upstream name — must be on the policy allowlist. */
  upstream: string;
  /**
   * Base64-encoded x402 challenge JSON (what the client would have
   * decoded from `Payment-Required` or the 402 body).
   */
  challenge_base64: string;
}

export interface PayForApiOutput {
  /** Header name to add on retry — `X-PAYMENT` (v1) or `Payment-Signature` (v2). */
  header_name: 'X-PAYMENT' | 'Payment-Signature';
  /** Base64url-encoded payment payload to use as the header value. */
  header_value: string;
  /** USDC TransferWithAuthorization digest — ties the row in the payment log. */
  authorization_digest: Hex;
  /** The grant this payment was charged against. */
  grant_id: string;
  payment_log_id: number;
}

export async function handlePayForApi(
  ctx: ToolContext,
  input: PayForApiInput,
): Promise<PayForApiOutput | MCPError> {
  const adapter = getUpstreamAdapter(input.upstream);
  if (!adapter) {
    return buildMcpError({
      code: 'CONFIG_MISSING',
      category: 'config',
      text: `Leash: upstream "${input.upstream}" has no adapter on this build.`,
      details: { upstream: input.upstream },
      suggested_action: 'use a supported upstream or file a request for a new adapter',
    });
  }

  // Decode the base64 challenge and hand it to the core parser.
  let challenge;
  try {
    const decoded = Buffer.from(input.challenge_base64, 'base64').toString('utf8');
    challenge = parseX402Challenge({ headers: {}, body: decoded });
  } catch (e) {
    return buildMcpError({
      code: 'CONFIG_MISSING',
      category: 'config',
      text: `Leash: could not parse challenge_base64: ${(e as Error).message}`,
      details: { error: (e as Error).message },
      suggested_action: 'check that the input is base64-encoded JSON',
    });
  }

  const chosen = challenge.accepts[0];
  const amount = BigInt(chosen.amount);

  const policy = checkPolicy({
    grant: ctx.runtime.signedGrant.grant,
    amount,
    target: {
      kind: 'x402',
      upstream: input.upstream,
      recipient: chosen.payTo,
    },
    db: ctx.db,
  });
  if (!policy.ok) {
    return policyDenialToMcpError(policy.denialCode, policy.details);
  }

  const sessionKey = ctx.sessionKeys.loadAgentKey(ctx.runtime.agentName);
  const signed = await signX402Payment({
    challenge,
    chosen,
    adapter,
    runtime: ctx.runtime,
    sessionKey,
  });

  const paymentId = ctx.db.insertPayment({
    grantId: ctx.runtime.signedGrant.grant.id,
    kind: 'x402_payment',
    amount,
    recipient: chosen.payTo,
    upstream: input.upstream,
    authorizationDigest: signed.authorizationDigest,
    status: 'pending',
  });

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

  return {
    header_name: header.name,
    header_value: header.value,
    authorization_digest: signed.authorizationDigest,
    grant_id: ctx.runtime.signedGrant.grant.id,
    payment_log_id: paymentId,
  };
}
