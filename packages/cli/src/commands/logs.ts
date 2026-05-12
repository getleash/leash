import { formatUsdc } from '@getleash/core';
import { loadCliRuntime, openPaymentLog, runWithConfig } from '../runtime.js';
import type { PaymentRow } from '@getleash/mcp-server';

// ─── leash logs [agent] [--follow] ───────────────────────────────────
//
// Prints the payment log. Default view is reverse-chronological, last
// 50 entries. `--follow` polls every 1s for new rows and prints them
// as they arrive; SIGINT stops cleanly.
//
// Format: one line per payment. Times in UTC ISO 8601 to keep it
// greppable across TZ changes. Statuses are color-free plain text —
// we'll add ANSI only once a doctor/logs renderer ships.

const FOLLOW_INTERVAL_MS = 1000;

export async function logs(args: string[]): Promise<number> {
  const { agentName, follow } = parseArgs(args);
  if (!agentName) {
    process.stderr.write(
      'leash logs: missing agent name. Usage: leash logs <agent> [--follow]\n',
    );
    return 2;
  }
  return runWithConfig(() =>
    follow ? logsFollow(agentName) : logsTail(agentName),
  );
}

function parseArgs(args: string[]): { agentName?: string; follow: boolean } {
  let follow = false;
  let agentName: string | undefined;
  for (const a of args) {
    if (a === '--follow' || a === '-f') follow = true;
    else if (!a.startsWith('-')) agentName = a;
  }
  return { agentName, follow };
}

async function logsTail(agentName: string): Promise<number> {
  const cli = loadCliRuntime({ agentName });
  const db = openPaymentLog(cli.runtime);
  try {
    const rows = db.listRecent(cli.runtime.signedGrant.grant.id, 50);
    if (rows.length === 0) {
      process.stdout.write('(no payments yet)\n');
      return 0;
    }
    // listRecent returns newest-first; flip so the newest is at the
    // bottom — matches what `tail -f` would feel like.
    for (const row of rows.reverse()) {
      process.stdout.write(formatRow(row) + '\n');
    }
    return 0;
  } finally {
    db.close();
  }
}

async function logsFollow(agentName: string): Promise<number> {
  const cli = loadCliRuntime({ agentName });
  const db = openPaymentLog(cli.runtime);
  let cutoffId = -1;
  try {
    const initial = db.listRecent(cli.runtime.signedGrant.grant.id, 50);
    for (const row of initial.reverse()) process.stdout.write(formatRow(row) + '\n');
    if (initial.length > 0) cutoffId = initial[initial.length - 1].id;

    let stopping = false;
    const onSig = () => {
      stopping = true;
    };
    process.on('SIGINT', onSig);
    process.on('SIGTERM', onSig);

    while (!stopping) {
      await new Promise((r) => setTimeout(r, FOLLOW_INTERVAL_MS));
      const rows = db
        .listRecent(cli.runtime.signedGrant.grant.id, 200)
        .filter((r) => r.id > cutoffId)
        .reverse();
      for (const row of rows) {
        process.stdout.write(formatRow(row) + '\n');
        if (row.id > cutoffId) cutoffId = row.id;
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

function formatRow(row: PaymentRow): string {
  const ts = new Date(row.created_at_ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const amount = `${formatUsdc(BigInt(row.amount_base))} USDC`.padStart(14);
  const kind = row.kind === 'x402_payment' ? 'x402' : 'op'.padEnd(4);
  const status = row.status.padEnd(9);
  const recipient = `${row.recipient.slice(0, 10)}…${row.recipient.slice(-4)}`;
  const trailer =
    row.upstream
      ? `(${row.upstream})`
      : row.tx_hash && row.tx_hash !== '0x' + '00'.repeat(32)
        ? `tx ${row.tx_hash.slice(0, 10)}…`
        : '';
  return `${ts}  ${kind.padEnd(4)}  ${amount} → ${recipient}  ${status} ${trailer}`;
}
