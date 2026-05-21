// Walking-skeleton demo. Runs every §1 + §5 transcript from
// summary/user-flows.md against stubs, captures output, and diffs
// against tests/fixtures/user-flows/*.txt. Exits 0 on all-green;
// non-zero with a readable diff on drift.
//
// `npm run demo:skeleton`

import { writeFileSync, mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { disposeContext, newContext, parseUsdc } from "./skeleton/context.js";
import { applyCmd, revokeCmd } from "./skeleton/cli.js";
import { buildLeashMcp } from "./skeleton/mcp-server.js";
import { diffAgainstFixture, diffJson, type DiffResult } from "./skeleton/diff.js";
import { readFileSync } from "node:fs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = join(REPO_ROOT, "tests/fixtures/user-flows");
const POLICY_SRC = join(REPO_ROOT, "examples/cryptonit/cryptonit-policy.md");

async function main() {
  const results: DiffResult[] = [];
  const tmp = mkdtempSync(join(tmpdir(), "leash-skeleton-"));
  // user-flows.md is a same-session 3-minute quickstart: apply and the
  // first paid call both happen on 2026-04-16. Expiry = apply + 30d.
  const ctx = newContext(tmp, "2026-04-16T17:22:00Z");

  try {
    // Stage the example policy into the pretend agent repo.
    const policyPath = join(tmp, "cryptonit-policy.md");
    copyFileSync(POLICY_SRC, policyPath);

    // ---- §1.4 first-run ----
    ctx.writer.reset();
    applyCmd(ctx, "cryptonit-policy.md"); // relative path, matches fixture's rendering
    results.push(
      diffAgainstFixture(
        "§1.4 apply (first run)",
        ctx.writer.capture(),
        join(FIXTURES, "01-apply-first-run.txt"),
      ),
    );

    // ---- Fund the hub out-of-band (simulates John sending USDC) ----
    ctx.ledger.mint(ctx.hubAddr, parseUsdc("5.00"));

    // ---- §1.4 funded-run ----
    ctx.writer.reset();
    applyCmd(ctx, "cryptonit-policy.md");
    results.push(
      diffAgainstFixture(
        "§1.4 apply (funded run)",
        ctx.writer.capture(),
        join(FIXTURES, "02-apply-funded-run.txt"),
      ),
    );

    // ---- §1.5 first paid call from Claude ----
    // Advance the clock to 17:24:18 (matches the fixture's quoted_at).
    ctx.clock.set("2026-04-16T17:24:18Z");
    const mcp = await buildLeashMcp(ctx);
    const toolRes = await mcp.client.callTool({
      name: "coinmarketcap__get_price",
      arguments: { symbol: "BTC" },
    });
    const expectedCall = JSON.parse(
      readFileSync(join(FIXTURES, "03-first-paid-call.json"), "utf8"),
    );
    results.push(
      diffJson(
        "§1.5 first paid call — tool response",
        {
          tool: "coinmarketcap__get_price",
          arguments: { symbol: "BTC" },
          response: (toolRes as any).structuredContent,
        },
        join(FIXTURES, "03-first-paid-call.json"),
      ),
    );

    // ---- §1.5 leash.log line ----
    // Capture the log line from the first paid call BEFORE the filler
    // calls append their own lines — the fixture shows just one entry.
    const firstLogLine = readFileSync(join(ctx.cwd, ".leash", "leash.log"), "utf8");
    results.push(
      diffAgainstFixture(
        "§1.5 leash.log line",
        firstLogLine,
        join(FIXTURES, "04-leash-log-line.txt"),
      ),
    );

    // ---- Filler: 12 more paid calls to reach spent_today = 0.13 ----
    // Two pinned by §2.2 payments table (ETH quotes @17:25:02, SOL price
    // @17:25:04), then 10 more filler price calls.
    ctx.clock.set("2026-04-16T17:25:02Z");
    await mcp.client.callTool({ name: "coinmarketcap__get_quotes", arguments: { symbol: "ETH" } });
    ctx.clock.set("2026-04-16T17:25:04Z");
    await mcp.client.callTool({ name: "coinmarketcap__get_price", arguments: { symbol: "SOL" } });
    for (let i = 0; i < 10; i++) {
      ctx.clock.advance(30); // 30 s between filler calls
      await mcp.client.callTool({
        name: "coinmarketcap__get_price",
        arguments: { symbol: i % 2 === 0 ? "BTC" : "ETH" },
      });
    }

    // ---- §2.1 get_api_budget ----
    const budgetRes = await mcp.client.callTool({
      name: "get_api_budget",
      arguments: {},
    });
    results.push(
      diffJson(
        "§2.1 get_api_budget",
        {
          tool: "get_api_budget",
          response: (budgetRes as any).structuredContent,
        },
        join(FIXTURES, "07-get-api-budget.json"),
      ),
    );

    // ---- Helper: diff an MCP tool error against a fixture ----
    const diffError = async (
      label: string,
      call: () => Promise<unknown>,
      fixturePath: string,
    ) => {
      const res = (await call()) as any;
      const s = res.structuredContent;
      const t = res.content?.[0]?.text ?? "";
      results.push(
        diffJson(
          label,
          {
            tool: "coinmarketcap__get_price",
            arguments: { symbol: "BTC" },
            error: {
              isError: true,
              code: s?.code,
              category: s?.category,
              text: t,
              details: s?.details,
              suggested_action: s?.suggested_action,
            },
          },
          fixturePath,
        ),
      );
    };

    // ---- §7 OVER_DAILY_CAP ----
    // After §2.1 spent_today=0.13. Top up SQLite with synthetic rows
    // totaling 0.87 so the next call puts spent over 1.00.
    const fillerAmount = parseUsdc("0.87");
    ctx.db
      .prepare(
        "INSERT INTO payments(at_iso,tool,args_json,amount_base,recipient,tx_hash,facilitator) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        ctx.clock.nowIso(),
        "coinmarketcap__get_price",
        JSON.stringify({ symbol: "FILL" }),
        fillerAmount.toString(),
        ctx.cmcRecipient,
        "0xpay…",
        "0xcdp…",
      );
    // Ensure balance is enough so the balance check doesn't fire first.
    ctx.ledger.mint(ctx.subAddr, parseUsdc("1.00"));
    await diffError(
      "§7 OVER_DAILY_CAP",
      () => mcp.client.callTool({ name: "coinmarketcap__get_price", arguments: { symbol: "BTC" } }),
      join(FIXTURES, "08-over-daily-cap-error.json"),
    );

    // ---- §7 INSUFFICIENT_FUNDS ----
    // Roll the clock to a new day (so daily spend resets), drain the
    // sub-account to zero, then try to call.
    ctx.clock.set("2026-04-17T10:00:00Z");
    ctx.ledger.transfer(ctx.subAddr, ctx.hubAddr, ctx.ledger.balance(ctx.subAddr));
    await diffError(
      "§7 INSUFFICIENT_FUNDS",
      () => mcp.client.callTool({ name: "coinmarketcap__get_price", arguments: { symbol: "BTC" } }),
      join(FIXTURES, "09-insufficient-funds-error.json"),
    );

    // ---- §7 SESSION_KEY_EXPIRED ----
    // Advance past the session-key expiry (validUntil = 2026-05-16 17:22 UTC).
    ctx.clock.set("2026-05-17T09:00:00Z");
    ctx.ledger.mint(ctx.subAddr, parseUsdc("1.00")); // balance check would pass
    await diffError(
      "§7 SESSION_KEY_EXPIRED",
      () => mcp.client.callTool({ name: "coinmarketcap__get_price", arguments: { symbol: "BTC" } }),
      join(FIXTURES, "10-session-key-expired-error.json"),
    );

    // ---- §5.1 revoke ----
    // Roll the clock back to §5's original window (the §5 narrative
    // happens on apply day, not a month later).
    ctx.clock.set("2026-04-16T18:00:00Z");
    ctx.writer.reset();
    // Fixture pins "1.87 USDC remains in it". After §2.1 the sub-account
    // holds 0.87; the narrative implies an out-of-band top-up between
    // §2.1 and §5.1 (§3.1 shows `leash fund cryptonit 2.00` but §5's
    // story happens after partial spending, leaving 1.87). Stage the mint
    // directly so the fixture line matches.
    const current = ctx.ledger.balance(ctx.subAddr);
    const target = parseUsdc("1.87");
    if (current < target) ctx.ledger.mint(ctx.subAddr, target - current);
    revokeCmd(ctx, "cryptonit");
    results.push(
      diffAgainstFixture(
        "§5.1 revoke",
        ctx.writer.capture(),
        join(FIXTURES, "05-revoke.txt"),
      ),
    );

    // ---- §5.2 post-revoke call returns ON_CHAIN_REVOKED ----
    const errRes = await mcp.client.callTool({
      name: "coinmarketcap__get_price",
      arguments: { symbol: "BTC" },
    });
    const structured = (errRes as any).structuredContent;
    const textContent = (errRes as any).content?.[0]?.text ?? "";
    results.push(
      diffJson(
        "§5.2 post-revoke tool error",
        {
          tool: "coinmarketcap__get_price",
          arguments: { symbol: "BTC" },
          error: {
            isError: true,
            code: structured?.code,
            category: structured?.category,
            text: textContent,
            details: structured?.details,
            suggested_action: structured?.suggested_action,
          },
        },
        join(FIXTURES, "06-post-revoke-error.json"),
      ),
    );

    // ---- §6 renewal ----
    // Narrative: session key expired yesterday (2026-05-16 17:22), today
    // is 2026-05-17 14:05. Fixture pins Balance: 0.87 USDC and Hub: 4.13.
    ctx.clock.set("2026-05-17T14:05:00Z");
    const subCur = ctx.ledger.balance(ctx.subAddr);
    const subTarget = parseUsdc("0.87");
    if (subCur > subTarget) ctx.ledger.transfer(ctx.subAddr, ctx.hubAddr, subCur - subTarget);
    else if (subCur < subTarget) ctx.ledger.mint(ctx.subAddr, subTarget - subCur);
    const hubCur = ctx.ledger.balance(ctx.hubAddr);
    const hubTarget = parseUsdc("4.13");
    if (hubCur < hubTarget) ctx.ledger.mint(ctx.hubAddr, hubTarget - hubCur);
    else if (hubCur > hubTarget) ctx.ledger.transfer(ctx.hubAddr, "0xVoid", hubCur - hubTarget);
    ctx.writer.reset();
    applyCmd(ctx, "cryptonit-policy.md");
    results.push(
      diffAgainstFixture(
        "§6 renewal",
        ctx.writer.capture(),
        join(FIXTURES, "11-renewal.txt"),
      ),
    );

    await mcp.close();
  } finally {
    disposeContext(ctx, { keep: process.env.KEEP === "1" });
  }

  // Print results.
  let allGreen = true;
  for (const r of results) {
    console.log(r.message);
    if (!r.ok) allGreen = false;
  }
  console.log();
  console.log(
    allGreen
      ? `✓ all ${results.length} fixtures matched`
      : `✗ ${results.filter((r) => !r.ok).length}/${results.length} fixtures drifted`,
  );
  process.exit(allGreen ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
