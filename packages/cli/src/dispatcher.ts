// ─── Command dispatcher ──────────────────────────────────────────────
//
// Hand-rolled argv handling (no commander / yargs). Each command
// lives in its own file under src/commands/ and is lazy-loaded so
// `leash --help` doesn't pay to import serve+SQLite+viem.
//
// Registers the full CLI surface: serve, status, logs, fund, drain,
// revoke, apply, doctor, export-backup, import-backup.

export interface Command {
  name: string;
  /** Short one-liner shown in `leash --help`. */
  synopsis: string;
  /** Usage line. */
  usage: string;
  /** Whether the command is shipped in this build. */
  available: boolean;
  /** Lazy loader. */
  load: () => Promise<(args: string[]) => Promise<number>>;
}

export const COMMANDS: Command[] = [
  {
    name: 'serve',
    synopsis: "Start the MCP server for <agent> (Claude Code spawns this via .mcp.json)",
    usage: 'leash serve <agent>',
    available: true,
    load: async () => (await import('./commands/serve.js')).serve,
  },
  {
    name: 'apply',
    synopsis: 'Deploy sub-account, install session key, write .mcp.json',
    usage: 'leash apply <policy>.md',
    available: true,
    load: async () => (await import('./commands/apply.js')).apply,
  },
  {
    name: 'status',
    synopsis: 'Show balance, spend, and session-key expiry',
    usage: 'leash status [agent]',
    available: true,
    load: async () => (await import('./commands/status.js')).status,
  },
  {
    name: 'logs',
    synopsis: 'Tail the payment log',
    usage: 'leash logs [agent] [--follow]',
    available: true,
    load: async () => (await import('./commands/logs.js')).logs,
  },
  {
    name: 'fund',
    synopsis: 'Top up a sub-account from the hub',
    usage: 'leash fund <agent> <amount>',
    available: true,
    load: async () => (await import('./commands/fund.js')).fund,
  },
  {
    name: 'drain',
    synopsis: "Return all of a sub-account's balance to the hub (mandatory recovery path)",
    usage: 'leash drain <agent>',
    available: true,
    load: async () => (await import('./commands/drain.js')).drain,
  },
  {
    name: 'revoke',
    synopsis: "Kill an agent's session key on-chain",
    usage: 'leash revoke <agent>',
    available: true,
    load: async () => (await import('./commands/revoke.js')).revoke,
  },
  {
    name: 'doctor',
    synopsis: 'Diagnose common breakages (on-chain checks included; --offline skips them)',
    usage: 'leash doctor [--offline]',
    available: true,
    load: async () => (await import('./commands/doctor.js')).doctor,
  },
  {
    name: 'export-backup',
    synopsis: 'Write an encrypted (Argon2id + AES-GCM) snapshot of .leash/',
    usage: 'leash export-backup <path>',
    available: true,
    load: async () => (await import('./commands/export-backup.js')).exportBackup,
  },
  {
    name: 'import-backup',
    synopsis: 'Restore an encrypted backup into .leash/ (refuses to clobber)',
    usage: 'leash import-backup <path>',
    available: true,
    load: async () => (await import('./commands/import-backup.js')).importBackup,
  },
];

export function renderHelp(): string {
  const rows = COMMANDS.map((c) => {
    const name = c.available ? c.name : `${c.name} (soon)`;
    return `  ${name.padEnd(20)} ${c.synopsis}`;
  });
  return [
    'leash — AI agent wallet on Base L2',
    '',
    'Usage:',
    '  leash <command> [args...]',
    '  leash --help',
    '',
    'Commands:',
    ...rows,
    '',
    'Environment:',
    '  LEASH_BASE_RPC           Base mainnet RPC endpoint (optional)',
    '  LEASH_BASE_SEPOLIA_RPC   Base sepolia RPC endpoint (optional)',
    '  LEASH_KEY_STORE=file     Force file-backed key store on macOS',
  ].join('\n');
}

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name);
}
