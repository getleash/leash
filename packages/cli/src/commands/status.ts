import { erc20Abi, formatUsdc } from '@getleash/core';
import { listAgentsOnDisk, loadCliRuntime, openPaymentLog, runWithConfig } from '../runtime.js';

// ─── leash status [agent] ────────────────────────────────────────────
//
// No argument: one line per agent (name, sub-account, live USDC balance).
// With argument: a block with full detail — session key, expiry,
// balance, spend/remaining per window, transaction count.

export async function status(args: string[]): Promise<number> {
  const maybeAgent = args[0];
  if (!maybeAgent) return statusSummary();
  return runWithConfig(() => statusOne(maybeAgent));
}

async function statusSummary(): Promise<number> {
  const agents = listAgentsOnDisk();
  if (agents.length === 0) {
    process.stdout.write(
      'No agents registered. Run `leash apply <policy>.md` to create one.\n',
    );
    return 0;
  }
  const rows: string[] = [];
  for (const name of agents) {
    try {
      const cli = loadCliRuntime({ agentName: name });
      const balance = (await cli.publicClient.readContract({
        address: cli.runtime.chainConfig.usdc,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [cli.runtime.agent.subAccount],
      })) as bigint;
      rows.push(
        `  ${name.padEnd(16)} ` +
          `${cli.runtime.agent.subAccount.slice(0, 10)}…${cli.runtime.agent.subAccount.slice(-4)}  ` +
          `${formatUsdc(balance).padStart(10)} USDC`,
      );
    } catch (e) {
      rows.push(`  ${name.padEnd(16)} <error: ${(e as Error).message}>`);
    }
  }
  process.stdout.write(`Agents (${agents.length}):\n${rows.join('\n')}\n`);
  return 0;
}

async function statusOne(agentName: string): Promise<number> {
  const cli = loadCliRuntime({ agentName });
  const grant = cli.runtime.signedGrant.grant;
  const nowMs = Date.now();
  const db = openPaymentLog(cli.runtime);
  try {
    const balance = (await cli.publicClient.readContract({
      address: cli.runtime.chainConfig.usdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [cli.runtime.agent.subAccount],
    })) as bigint;

    const spentDay = db.getSpent(grant.id, 'day', nowMs);
    const spentWeek = db.getSpent(grant.id, 'week', nowMs);
    const spentMonth = db.getSpent(grant.id, 'month', nowMs);
    const txCount = db.listRecent(grant.id, 10_000).length;

    const expiresIso = new Date(grant.validUntil * 1000).toISOString();
    const daysLeft = Math.max(
      0,
      Math.floor((grant.validUntil - nowMs / 1000) / 86_400),
    );

    const lines = [
      `${agentName} — ${cli.runtime.chainConfig.name}:`,
      `  hub:         ${cli.runtime.hub.hub}`,
      `  sub-account: ${cli.runtime.agent.subAccount}`,
      `  session key: ${cli.runtime.agent.sessionKey}`,
      `  expires:     ${expiresIso} (${daysLeft}d left)`,
      `  balance:     ${formatUsdc(balance)} USDC`,
      '',
      `  spent today:     ${pad(formatUsdc(spentDay))} / ${pad(formatUsdc(grant.limits.daily))} USDC  (${pad(formatUsdc(clampNonNegative(grant.limits.daily - spentDay)))} remaining)`,
      `  spent this week: ${pad(formatUsdc(spentWeek))} / ${pad(formatUsdc(grant.limits.weekly))} USDC  (${pad(formatUsdc(clampNonNegative(grant.limits.weekly - spentWeek)))} remaining)`,
      `  spent this mo.:  ${pad(formatUsdc(spentMonth))} / ${pad(formatUsdc(grant.limits.monthly))} USDC  (${pad(formatUsdc(clampNonNegative(grant.limits.monthly - spentMonth)))} remaining)`,
      '',
      `  transactions:   ${txCount}`,
    ];
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  } finally {
    db.close();
  }
}

function pad(s: string): string {
  return s.padStart(7);
}

function clampNonNegative(v: bigint): bigint {
  return v < 0n ? 0n : v;
}
