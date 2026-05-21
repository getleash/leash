#!/usr/bin/env node
import { findCommand, renderHelp } from './dispatcher.js';

// ─── CLI entrypoint ──────────────────────────────────────────────────
//
// `leash` is a thin dispatcher. Each command is a lazy import so
// `leash --help` and `leash` (no args) don't pay to load viem /
// better-sqlite3 / the MCP SDK.

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === '-h' || command === '--help') {
    process.stdout.write(renderHelp() + '\n');
    return command ? 0 : 1; // `leash` with no args = exit 1, `--help` = 0.
  }

  if (command === '-v' || command === '--version') {
    process.stdout.write('leash 0.1.0\n');
    return 0;
  }

  const cmd = findCommand(command);
  if (!cmd) {
    process.stderr.write(
      `leash: unknown command "${command}". Run \`leash --help\` for the list.\n`,
    );
    return 2;
  }

  const handler = await cmd.load();
  return handler(args);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`leash: ${err.stack ?? err}\n`);
    process.exit(1);
  });
