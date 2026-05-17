import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { MCPError } from '@getleash/core';
import type { ToolContext } from './types.js';
import { handleGetBalance } from './get_balance.js';
import { handleGetApiBudget } from './get_api_budget.js';
import { handleTransfer } from './transfer.js';
import { handleRevokeSessionKey } from './revoke_session_key.js';
import { handlePayForApi } from './pay_for_api.js';
import { PaidToolCaller } from '../proxy/paid-caller.js';

function isMcpError(x: unknown): x is MCPError {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as { isError?: unknown }).isError === true
  );
}

// zod's inferred types are deep enough to trip TS2589 when tsup
// generates declaration files through the registerTool overloads.
// The runtime validation still works — we opt the shapes out of the
// declaration-file type graph with an `any`-typed re-binding.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UntypedRegister = any;

// ─── Tool registration ───────────────────────────────────────────────
//
// Phase 6a: all five own tools are registered. Read-only tools
// (get_balance, get_api_budget) work against the live chain /
// grant. Write tools (pay_for_api, transfer, revoke_session_key)
// return a structured "not yet implemented" error so Claude can
// surface it cleanly; real implementations land in 6b/6c.
//
// Rationale for registering the stubs now rather than waiting:
// CLAUDE.md promises these tools exist; the MCP surface should
// match the documentation from day one so users (and the agent
// itself) see a consistent list.

export function registerLeashTools(server: McpServer, ctx: ToolContext): void {
  const s: UntypedRegister = server;
  // ─── get_balance ────────────────────────────────────────────────
  s.registerTool(
    'get_balance',
    {
      description:
        "Returns the USDC balance of an address on Base (default: this " +
        "agent's sub-account). Read-only; does not sign anything.",
      inputSchema: {
        account: z
          .string()
          .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte 0x address')
          .optional()
          .describe("Address to check. Defaults to this agent's sub-account."),
      },
    },
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const out = await handleGetBalance(ctx, {
        account: args.account as `0x${string}` | undefined,
      });
      return {
        content: [{ type: 'text', text: `${out.balance_usdc} USDC` }],
        structuredContent: out as unknown as Record<string, unknown>,
      };
    },
  );

  // ─── get_api_budget ─────────────────────────────────────────────
  s.registerTool(
    'get_api_budget',
    {
      description:
        'Returns the spend limits, amount spent so far, and the session ' +
        "key's expiry. Use this before calling any paid upstream tool.",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      const out = await handleGetApiBudget(ctx);
      const text =
        `Daily remaining: ${out.remaining.today_usdc} USDC of ${out.limits.daily_usdc} ` +
        `(session expires ${out.session_key_expires_at_iso}).`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: out as unknown as Record<string, unknown>,
      };
    },
  );

  // ─── pay_for_api (explicit signing) ─────────────────────────────

  s.registerTool(
    'pay_for_api',
    {
      description:
        'Explicitly sign an EIP-3009 USDC TransferWithAuthorization for ' +
        'an x402 challenge produced by an upstream outside the Leash ' +
        'proxy. Returns {header_name, header_value} ready to send on ' +
        'retry. Rarely needed — republished upstream tools handle 402s ' +
        'automatically.',
      inputSchema: {
        upstream: z
          .string()
          .describe('Upstream name — must match a supported adapter (e.g. "coinmarketcap").'),
        challenge_base64: z
          .string()
          .describe('Base64-encoded x402 challenge JSON.'),
      },
    },
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const out = await handlePayForApi(ctx, {
        upstream: args.upstream as string,
        challenge_base64: args.challenge_base64 as string,
      });
      if (isMcpError(out)) return out as unknown as CallToolResult;
      return {
        content: [
          {
            type: 'text',
            text: `Signed x402 payment. Set header ${out.header_name}: <value>.`,
          },
        ],
        structuredContent: out as unknown as Record<string, unknown>,
      };
    },
  );

  s.registerTool(
    'transfer',
    {
      description:
        'USDC UserOp to a whitelisted counterparty. Signed by the session ' +
        'key; routed through Kernel → SessionKeyValidator. Checks per-tx ' +
        'and daily/weekly/monthly caps before signing.',
      inputSchema: {
        to: z
          .string()
          .regex(/^0x[0-9a-fA-F]{40}$/)
          .describe('Recipient address — must be on the policy allowlist.'),
        amount_usdc: z
          .string()
          .regex(/^\d+(\.\d+)?$/)
          .describe('Amount in USDC as a decimal string, e.g. "1.00".'),
      },
    },
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const out = await handleTransfer(ctx, {
        to: args.to as `0x${string}`,
        amount_usdc: args.amount_usdc as string,
      });
      if (isMcpError(out)) return out as unknown as CallToolResult;
      return {
        content: [
          {
            type: 'text',
            text: `Transferred ${out.amount_usdc} USDC to ${out.recipient} (tx ${out.tx_hash}).`,
          },
        ],
        structuredContent: out as unknown as Record<string, unknown>,
      };
    },
  );

  s.registerTool(
    'revoke_session_key',
    {
      description:
        "Hub-owner direct call that uninstalls the session-key validator on " +
        "the sub-account. Emergency kill — the agent can no longer sign " +
        'after this lands on-chain. Requires ETH on the hub-owner EOA.',
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      const out = await handleRevokeSessionKey(ctx);
      if (isMcpError(out)) return out as unknown as CallToolResult;
      return {
        content: [
          {
            type: 'text',
            text: `Session key revoked on-chain at block ${out.block_number} (tx ${out.tx_hash}).`,
          },
        ],
        structuredContent: out as unknown as Record<string, unknown>,
      };
    },
  );

  // ─── Republished upstream tools ──────────────────────────────────
  //
  // For each open upstream session, forward every tool under a
  // `<namespace>__<name>` prefix. The PaidToolCaller handles the 402
  // → sign → retry loop + SQLite logging + meta.leash embedding.
  for (const upstream of ctx.upstreams) {
    const caller = new PaidToolCaller({
      adapter: upstream.adapter,
      client: upstream.client,
      ctx,
    });
    for (const tool of upstream.tools) {
      const localName = `${upstream.namespace}__${tool.name}`;
      s.registerTool(
        localName,
        {
          description:
            tool.description ??
            `Forwarded tool from ${upstream.name}. Calls ${upstream.name}.${tool.name} with automatic x402 payment on 402.`,
          // Translate the upstream's JSON-schema properties into a
          // ZodRawShape. The MCP SDK wraps a ZodRawShape in
          // `z.object(shape)`, which strict-strips unknown keys — so
          // a `{}` here drops EVERY arg before reaching the handler
          // and the upstream sees an empty body / no query params
          // (then takes the payment and 400s on its own validation).
          // We pass the real shape so the agent's args flow through
          // intact; the upstream still does its own final validation.
          inputSchema: jsonSchemaToZodShape(tool.inputSchema),
        },
        async (args: Record<string, unknown>): Promise<CallToolResult> => {
          return caller.callTool(tool.name, args);
        },
      );
    }
  }
}

/**
 * Translate a JSON-schema fragment (as published by the upstream's
 * tool descriptor) into a Zod raw shape suitable for `registerTool`'s
 * `inputSchema`. Best-effort: handles the basic JSON-schema types we
 * see in the catalog. Anything we can't classify falls through as
 * `z.unknown()` — the upstream does the final validation.
 */
function jsonSchemaToZodShape(schema: unknown): z.ZodRawShape {
  if (!schema || typeof schema !== 'object') return {};
  const s = schema as Record<string, unknown>;
  const props = s.properties;
  if (!props || typeof props !== 'object') return {};
  const required = new Set<string>(
    Array.isArray(s.required) ? (s.required as string[]) : [],
  );
  const shape: z.ZodRawShape = {};
  for (const [key, raw] of Object.entries(props as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const field = raw as Record<string, unknown>;
    let zt: z.ZodTypeAny;
    switch (field.type) {
      case 'string':
        zt = Array.isArray(field.enum)
          ? z.enum(field.enum as [string, ...string[]])
          : z.string();
        break;
      case 'number':
      case 'integer':
        zt = z.number();
        break;
      case 'boolean':
        zt = z.boolean();
        break;
      case 'array':
        zt = z.array(z.unknown());
        break;
      case 'object':
        zt = z.record(z.unknown());
        break;
      default:
        zt = z.unknown();
    }
    if (typeof field.description === 'string') {
      zt = zt.describe(field.description);
    }
    if (!required.has(key)) {
      zt = zt.optional();
    }
    shape[key] = zt;
  }
  return shape;
}
