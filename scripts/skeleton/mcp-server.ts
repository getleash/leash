// Walking-skeleton MCP server. Registers Leash's five own tools + one
// republished CMC tool. The 402 settlement flow is simulated inline —
// there is no separate upstream process in Phase 1. Production (Phase 6)
// swaps this for a real HTTP client with adapter-driven 402 handling.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { Context } from "./context.js";
import { formatUsdc, headTailAddr, parseUsdc } from "./context.js";
import { readAgent } from "./state.js";
import { appendLog } from "./state.js";

export interface PaymentResult {
  txHash: string;
  facilitator: string;
  costBase: bigint;
  recipient: string;
}

export interface McpConn {
  server: McpServer;
  client: Client;
  close: () => Promise<void>;
}

// Per-tool short-form tx hash (the fixture pins these).
const TX_SHORT: Record<string, string> = {
  coinmarketcap__get_price: "0xpay…",
  coinmarketcap__get_quotes: "0xpaz…",
};

export async function buildLeashMcp(ctx: Context): Promise<McpConn> {
  const server = new McpServer({ name: "leash", version: "0.1.0" });
  const agent = readAgent(ctx);

  // ---- Own tool: get_balance ----
  server.registerTool(
    "get_balance",
    {
      description: "Sub-account USDC balance (read-only).",
      inputSchema: {},
    },
    async () => {
      const bal = ctx.ledger.balance(ctx.subAddr);
      return {
        content: [{ type: "text", text: `${formatUsdc(bal)} USDC` }],
        structuredContent: {
          usdc_base_units: bal.toString(),
          usdc_human: formatUsdc(bal),
        },
      };
    },
  );

  // ---- Own tool: get_api_budget ----
  server.registerTool(
    "get_api_budget",
    {
      description: "Daily/weekly/monthly spend + session-key expiry (read-only).",
      inputSchema: {},
    },
    async () => {
      const spent = sumToday(ctx);
      const daily = BigInt(agent.dailyLimitBase);
      const weekly = BigInt(agent.weeklyLimitBase);
      const monthly = BigInt(agent.monthlyLimitBase);
      const bal = ctx.ledger.balance(ctx.subAddr);
      return {
        content: [{ type: "text", text: `spent today ${formatUsdc(spent)}` }],
        structuredContent: {
          daily_remaining_usdc: formatUsdc(daily - spent),
          weekly_remaining_usdc: formatUsdc(weekly - spent),
          monthly_remaining_usdc: formatUsdc(monthly - spent),
          spent_today_usdc: formatUsdc(spent),
          session_key_expires_at: agent.sessionKey.validUntil,
          sub_account_balance_usdc: formatUsdc(bal),
        },
      };
    },
  );

  // ---- Own tool: revoke_session_key ----
  server.registerTool(
    "revoke_session_key",
    {
      description: "Emergency kill — remove the session key on-chain (hub-signed UserOp).",
      inputSchema: {},
    },
    async () => {
      const r = ctx.bundler.revokeSessionKey(ctx.subAddr);
      ctx.revoked = true;
      ctx.revokedAtBlock = r.block;
      ctx.revokedAtTx = r.txHash;
      return {
        content: [{ type: "text", text: `revoked — tx ${r.txHash}` }],
        structuredContent: { tx_hash: r.txHash, status: "revoked" },
      };
    },
  );

  // Shared 402/pay/retry for any republished upstream tool.
  const paidCall = async (
    toolName: string,
    args: Record<string, unknown>,
    buildResult: () => Record<string, unknown>,
  ) => {
    // Error check order: auth → policy caps → funds.
    if (ctx.revoked) {
      return errShape(
        "ON_CHAIN_REVOKED",
        "auth",
        `Leash: session key for ${agent.name} was revoked on-chain at block ${ctx.revokedAtBlock}. Ask the user to run \`leash apply ${agent.name}-policy.md\` to re-enable.`,
        { revoked_at_block: ctx.revokedAtBlock!, revoked_at_tx: ctx.revokedAtTx! },
        `leash apply ${agent.name}-policy.md`,
      );
    }
    const validUntil = agent.sessionKey.validUntil;
    if (ctx.clock.nowIso() > validUntil) {
      return errShape(
        "SESSION_KEY_EXPIRED",
        "auth",
        `Leash: session key for ${agent.name} expired at ${humanUtc(validUntil)}. Ask the user to run \`leash apply ${agent.name}-policy.md\` to renew.`,
        { expired_at: validUntil },
        `leash apply ${agent.name}-policy.md`,
      );
    }

    const upstream = agent.upstreams.find((u) => u.namespace === "coinmarketcap");
    if (!upstream) throw new Error("coinmarketcap upstream not configured");
    const costBase = parseUsdc("0.01");
    const maxPerTx = BigInt(agent.maxPerTxBase);
    const dailyCap = BigInt(agent.dailyLimitBase);
    if (costBase > maxPerTx) {
      return errShape(
        "OVER_PER_TX_CAP",
        "budget",
        `Leash: this call costs ${formatUsdc(costBase)} USDC, which exceeds the per-transaction cap of ${formatUsdc(maxPerTx)} USDC set in ${agent.name}-policy.md. Increase max_per_transaction and re-apply, or skip this call.`,
        { requested_usdc: formatUsdc(costBase), cap_usdc: formatUsdc(maxPerTx), upstream: upstream.name, tool: toolName },
        "edit policy.md → increase max_per_transaction, then `leash apply`",
      );
    }
    const spent = sumToday(ctx);
    if (spent + costBase > dailyCap) {
      return errShape(
        "OVER_DAILY_CAP",
        "budget",
        `Leash: today's budget of ${formatUsdc(dailyCap)} USDC is spent. ${formatUsdc(dailyCap - spent)} USDC remaining until ${nextMidnightHuman(ctx)}. Increase daily_limit in ${agent.name}-policy.md and re-apply, or wait for reset.`,
        { window: "daily", remaining_usdc: formatUsdc(dailyCap - spent), resets_at: nextMidnightIso(ctx) },
        "wait for reset or edit policy.md → increase daily_limit",
      );
    }
    const subBal = ctx.ledger.balance(ctx.subAddr);
    if (subBal < costBase) {
      return errShape(
        "INSUFFICIENT_FUNDS",
        "funds",
        `Leash: ${agent.name}'s sub-account holds ${formatUsdc(subBal)} USDC, but this call needs ${formatUsdc(costBase)} USDC. Ask the user to run \`leash fund ${agent.name} <amount>\` to top it up from the hub.`,
        { balance_usdc: formatUsdc(subBal), required_usdc: formatUsdc(costBase), recipient: headTailAddr(upstream.recipient) },
        `leash fund ${agent.name} 1.00`,
      );
    }
    ctx.ledger.transfer(ctx.subAddr, upstream.recipient, costBase);
    const txHash = TX_SHORT[toolName] ?? "0xpay…";
    const facilitator = "0xcdp…";
    ctx.signer.sign(`${ctx.subAddr}->${upstream.recipient}:${costBase}`);

    ctx.db
      .prepare(
        "INSERT INTO payments(at_iso,tool,args_json,amount_base,recipient,tx_hash,facilitator) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        ctx.clock.nowIso(),
        toolName,
        JSON.stringify(args),
        costBase.toString(),
        upstream.recipient,
        txHash,
        facilitator,
      );

    const remaining = BigInt(agent.dailyLimitBase) - sumToday(ctx);
    const argsStr = Object.entries(args)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    appendLog(
      ctx,
      `${ctx.clock.nowUtcHMS()}  ${toolName}(${argsStr})\n` +
        `          paid ${formatUsdc(costBase)} USDC → ${headTailAddr(upstream.recipient)}\n` +
        `          tx ${txHash} (facilitator ${facilitator})   remaining today: ${formatUsdc(remaining)} USDC\n`,
    );

    const base = buildResult();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(base) }],
      structuredContent: {
        ...base,
        quoted_at: ctx.clock.nowIso(),
        cost_usdc: formatUsdc(costBase),
        remaining_daily_usdc: formatUsdc(remaining),
      },
    };
  };

  // ---- Republished upstream tool: coinmarketcap__get_price ----
  server.registerTool(
    "coinmarketcap__get_price",
    {
      description: "CMC spot price (paid — automatically settled via Leash policy.)",
      inputSchema: { symbol: z.string() },
    },
    async ({ symbol }: { symbol: string }) => {
      const priceTable: Record<string, string> = { BTC: "$67,432", ETH: "$3,121", SOL: "$187" };
      return paidCall("coinmarketcap__get_price", { symbol }, () => ({
        price: priceTable[symbol] ?? "$n/a",
      }));
    },
  );

  // ---- Republished upstream tool: coinmarketcap__get_quotes ----
  server.registerTool(
    "coinmarketcap__get_quotes",
    {
      description: "CMC quotes (paid — automatically settled via Leash policy.)",
      inputSchema: { symbol: z.string() },
    },
    async ({ symbol }: { symbol: string }) => {
      return paidCall("coinmarketcap__get_quotes", { symbol }, () => ({
        quotes: `${symbol} quotes`,
      }));
    },
  );

  // Note: transfer and pay_for_api tools are out of scope for Phase 1's
  // §1 + §5 fixtures. They'll register in Phase 6 alongside the real
  // on-chain allowlist plumbing.

  const [cTransport, sTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(sTransport);
  const client = new Client({ name: "skeleton-client", version: "0.1.0" });
  await client.connect(cTransport);

  return {
    server,
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function errShape(
  code: string,
  category: string,
  text: string,
  details: Record<string, unknown>,
  suggested_action: string,
) {
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
    structuredContent: { code, category, details, suggested_action },
  };
}

function humanUtc(iso: string): string {
  // "2026-05-16T17:22:00Z" → "2026-05-16 17:22 UTC"
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function nextMidnightIso(ctx: Context): string {
  const now = new Date(ctx.clock.nowIso());
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  return next.toISOString().replace(/\.\d{3}Z$/, "Z");
}
function nextMidnightHuman(ctx: Context): string {
  // "2026-04-17 00:00 UTC"
  const now = new Date(ctx.clock.nowIso());
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  return humanUtc(next.toISOString().replace(/\.\d{3}Z$/, "Z"));
}

function sumToday(ctx: Context): bigint {
  // Sum of payments today. The skeleton's clock is frozen within a run,
  // so "today" is just "all rows with at_iso on the same UTC date".
  const today = ctx.clock.nowIso().slice(0, 10);
  const row = ctx.db
    .prepare("SELECT COALESCE(SUM(amount_base),0) AS s FROM payments WHERE substr(at_iso,1,10) = ?")
    .get(today) as { s: number | bigint } | undefined;
  if (!row) return 0n;
  return BigInt(row.s as any);
}
