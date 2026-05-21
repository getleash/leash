// CLI command stubs for the walking skeleton. Each function
// takes a Context and writes into ctx.writer so the orchestrator can
// capture stdout and diff against tests/fixtures/user-flows/*.txt.
//
// No argparser here — the orchestrator calls these functions directly
// with parsed arguments. The real CLI binary replaces this.

import { isAbsolute, join } from "node:path";
import type { Context } from "./context.js";
import { formatUsdc } from "./context.js";
import { parsePolicyFile } from "./policy.js";
import {
  hasAgent,
  hasConfig,
  readAgent,
  writeAgent,
  writeConfig,
  writeMcpJson,
} from "./state.js";

// -------- `leash apply <policy>` --------

export function applyCmd(ctx: Context, policyPath: string) {
  const w = ctx.writer;
  const absPath = isAbsolute(policyPath) ? policyPath : join(ctx.cwd, policyPath);
  const policy = parsePolicyFile(absPath);
  w.println(`Parsed ${policyPath} ✓`);

  const ownerService = "com.leash.owner";

  // ---- First-run mode ----
  if (!hasConfig(ctx)) {
    w.println();
    w.println("First run detected — generating a new hub owner.");
    w.println();
    // Stub key generation.
    const hubPrivkey = "0xhubPrivateKey".padEnd(66, "0");
    ctx.keychain.set(ownerService, hubPrivkey);
    w.println("  ✓ Generated a new hub owner key (secp256k1).");
    w.println(`  ✓ Private key stored in macOS Keychain (service: ${ownerService}).`);
    w.println("  ✓ Config written to ./.leash/config.json.");
    w.println();
    w.println("  Your hub address (counterfactual, not yet deployed):");
    w.println();
    w.println(`      ${ctx.hubAddr}`);
    w.println();
    w.println("  Fund this address with USDC on Base, then rerun `leash apply`:");
    w.println();
    w.println("      • Network:      Base mainnet (chainId 8453)");
    w.println(`      • Token:        USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)`);
    w.println("      • Recommended:  at least 5 USDC");
    w.println("                      (≈ 500 CMC price lookups + gas reserve)");
    w.println();
    w.println("  Verify funding anytime with `leash status`.");

    writeConfig(ctx, { hub: ctx.hubAddr, createdAt: ctx.clock.nowIso() });
    return;
  }

  // ---- Renewal mode ----
  if (hasAgent(ctx)) {
    return renewal(ctx, policy, policyPath);
  }

  // ---- Funded-run mode ----
  const hubBal = ctx.ledger.balance(ctx.hubAddr);
  w.println(`Hub ${ctx.hubAddrShort} balance: ${formatUsdc(hubBal)} USDC ✓`);
  w.println();

  // Resolve upstream recipient (fixture pins CMC to 0x271189…0908).
  const up = policy.upstreams[0];
  const recipient = ctx.cmcRecipient;

  // Summary block.
  w.println("Summary");
  w.println("  Agent:             " + policy.name);
  w.println("  Chain:             base (8453)");
  w.println(`  Validity:          ${policy.validityDays} days (expires ${ctx.clock.plusDaysShort(policy.validityDays)})`);
  w.println(`  Initial funding:   ${formatUsdc(policy.initialFunding)} USDC  (from hub → sub-account)`);
  w.println();
  w.println("Limits");
  w.println(`  per-transaction:    ${formatUsdc(policy.limits.maxPerTx)} USDC`);
  w.println(`  daily:              ${formatUsdc(policy.limits.daily)} USDC`);
  w.println(`  weekly:             ${formatUsdc(policy.limits.weekly)} USDC`);
  w.println(`  monthly:           ${formatUsdc(policy.limits.monthly)} USDC`);
  w.println();
  w.println("Upstreams (resolved live)");
  w.println("  coinmarketcap");
  w.println(`    url:       ${up.url}`);
  w.println(`    recipient: ${recipient}`);
  w.println("    price:     0.01 USDC per call");
  w.println("    tools:     12 (get_price, get_listings, get_quotes, ...)");
  w.println();
  w.println("Recovery");
  w.println(`  drain_to_hub:      enabled  (hub ${ctx.hubAddrShort} can pull all funds, anytime)`);
  w.println();
  w.println("On-chain actions that will run");
  w.println("  1. Deploy hub contract                     (one-time, ≈ 0.0001 ETH gas)");
  w.println(`  2. Deploy sub-account for ${policy.name}        (≈ 0.0002 ETH gas)`);
  w.println(`  3. Register session key (expires ${ctx.clock.plusDaysDate(policy.validityDays)})`);
  w.println(`  4. Fund sub-account with ${formatUsdc(policy.initialFunding)} USDC from hub`);
  w.println();
  w.println("Hub balance before: 5.00 USDC / 0.0050 ETH");
  w.println("Hub balance after:  4.00 USDC / 0.0043 ETH (estimated)");
  w.println();
  w.println("Confirm? [y/N] y");
  w.println();

  // Simulated on-chain actions.
  w.println(`  Deploying hub ........................... ✓ ${ctx.hubAddrShort}  tx 0xaaa…`);
  w.println(`  Deploying sub-account for ${policy.name} ..... ✓ ${ctx.subAddrShort}  tx 0xbbb…`);
  w.println(`  Registering session key (${ctx.clock.plusDaysDate(policy.validityDays)}) .... ✓ tx 0xccc…`);
  w.println(`  Funding sub-account with ${formatUsdc(policy.initialFunding)} USDC ...... ✓ tx 0xddd…`);

  // Apply ledger effects.
  ctx.bundler.fundSub(ctx.hubAddr, ctx.subAddr, policy.initialFunding, "0xddd…");

  // Persist agent.json.
  writeAgent(ctx, {
    name: policy.name,
    hub: ctx.hubAddr,
    subAccount: ctx.subAddr,
    sessionKey: {
      address: ctx.sessionKeyAddr,
      validUntil: ctx.clock.plusDaysIso(policy.validityDays),
    },
    upstreams: [
      {
        name: up.name,
        url: up.url,
        namespace: up.namespace,
        recipient,
      },
    ],
    initialFundingBase: policy.initialFunding.toString(),
    dailyLimitBase: policy.limits.daily.toString(),
    weeklyLimitBase: policy.limits.weekly.toString(),
    monthlyLimitBase: policy.limits.monthly.toString(),
    maxPerTxBase: policy.limits.maxPerTx.toString(),
  });

  // Write .mcp.json.
  writeMcpJson(ctx, policy.name);

  w.println();
  w.println(`  ✓ ${policy.name} is ready.`);
  w.println("  ✓ Wrote .mcp.json — open Claude Code in this directory and the");
  w.println("    leash tools will be available.");
  w.println();
  w.println("      {");
  w.println('        "mcpServers": {');
  w.println('          "leash": {');
  w.println('            "command": "leash",');
  w.println(`            "args": ["serve", "${policy.name}"]`);
  w.println("          }");
  w.println("        }");
  w.println("      }");
}

// -------- Renewal branch of `leash apply` --------

function renewal(ctx: Context, policy: ReturnType<typeof parsePolicyFile>, _policyPath: string) {
  const w = ctx.writer;
  const agent = readAgent(ctx);
  w.println();
  w.println("  This agent is already deployed. `apply` will rotate its session key.");
  w.println();
  w.println("Summary");
  w.println(`  Agent:              ${agent.name}`);
  const oldExpiry = humanUtc(agent.sessionKey.validUntil);
  const relative = relativeDay(ctx, agent.sessionKey.validUntil);
  w.println(`  Current session:    expired ${oldExpiry} (${relative})`);
  const newExpiryHuman = `${ctx.clock.plusDaysDate(policy.validityDays)} ${ctx.clock.nowUtcShort()}`;
  w.println(`  New session:        expires ${newExpiryHuman} (${policy.validityDays} days)`);
  w.println("  Allowlist:          unchanged");
  w.println("  Limits:             unchanged");
  const subBal = ctx.ledger.balance(ctx.subAddr);
  w.println(`  Balance:            ${formatUsdc(subBal)} USDC  (unchanged — no additional funding)`);
  w.println();
  w.println("On-chain actions that will run");
  w.println("  1. Revoke old session key (tx)");
  w.println("  2. Register new session key (tx)");
  w.println();
  const hubBal = ctx.ledger.balance(ctx.hubAddr);
  w.println(`Hub balance before: ${formatUsdc(hubBal)} USDC / 0.0041 ETH`);
  w.println(`Hub balance after:  ${formatUsdc(hubBal)} USDC / 0.0038 ETH (estimated)`);
  w.println();
  w.println("Confirm? [y/N] y");
  w.println();
  w.println("  Revoking old session key ........... ✓ tx 0xrev…");
  w.println("  Registering new session key ........ ✓ tx 0xreg…");
  w.println();
  w.println(`  ${agent.name} is ready again. New session key, same limits, same balance.`);
  w.println();
  w.println("  (.mcp.json does not need to change — it already points at `leash serve cryptonit`.)");

  // Update agent.json with new session-key validUntil.
  agent.sessionKey.validUntil = ctx.clock.plusDaysIso(policy.validityDays);
  writeAgent(ctx, agent);
  ctx.revoked = false;
}

function humanUtc(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function relativeDay(ctx: Context, iso: string): string {
  const now = new Date(ctx.clock.nowIso());
  const then = new Date(iso);
  const dayDiff = Math.floor(
    (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
      Date.UTC(then.getUTCFullYear(), then.getUTCMonth(), then.getUTCDate())) /
      86400000,
  );
  if (dayDiff === 0) return "today";
  if (dayDiff === 1) return "yesterday";
  return `${dayDiff} days ago`;
}

// -------- `leash revoke <agent>` --------

export function revokeCmd(ctx: Context, agentName: string) {
  const w = ctx.writer;
  const agent = readAgent(ctx);
  if (agent.name !== agentName) {
    throw new Error(`no agent named '${agentName}' on this machine`);
  }

  // The fixture pins "expires 2026-05-14, ~1.00 USDC today" and
  // "1.87 USDC remains in it". To reproduce byte-for-byte we prime
  // the ledger to those values if not already there (the orchestrator
  // does this — leaving the revoke command pure).
  const subBalBefore = ctx.ledger.balance(ctx.subAddr);

  w.println("Summary");
  w.println(`  Sub-account:    ${ctx.subAddrShort}`);
  const expiryDate = agent.sessionKey.validUntil.slice(0, 10); // "YYYY-MM-DD"
  w.println(`  Session key:    ${ctx.sessionKeyAddrShort}   (expires ${expiryDate}, ~1.00 USDC today)`);
  w.println("  Action:         remove session key on-chain");
  w.println("  Signed by:      hub owner (Keychain)");
  w.println();
  w.println("This is irreversible. After revocation:");
  w.println("  • The agent cannot sign any more paid calls.");
  w.println("  • `leash apply <policy>` will register a fresh key if you want to re-enable.");
  w.println("  • Any in-flight UserOp already in the mempool may still land — on-chain");
  w.println("    validation will reject it after the revoke tx is mined.");
  w.println();
  w.println("Confirm? [y/N] y");
  w.println();

  // Submit the revoke UserOp.
  const r = ctx.bundler.revokeSessionKey(ctx.subAddr);
  ctx.revoked = true;
  ctx.revokedAtBlock = r.block;
  ctx.revokedAtTx = r.txHash;

  w.println(`  Submitting UserOp ................. ✓ user_op ${r.userOpHash}`);
  w.println(`  Waiting for on-chain confirmation . ✓ block ${r.block}  tx ${r.txHash}`);
  w.println();
  w.println(`  ${agent.name} session key is revoked.`);
  w.println(`  Sub-account ${ctx.subAddrShort} is inert.  ${formatUsdc(subBalBefore)} USDC remains in it.`);
  w.println(`  Run \`leash drain ${agent.name}\` to reclaim that balance to the hub,`);
  w.println(`  or \`leash apply ./${agent.name}-policy.md\` to register a new session key.`);
}

