import { resolve } from 'node:path';
import { serveStdio, type LeashMcpServerHandle } from '@getleash/mcp-server';
import { pickSessionKeyStore } from '../stores/index.js';

// ─── leash serve <agent> ─────────────────────────────────────────────
//
// What Claude Code spawns via .mcp.json. Stdio-only — the HTTP debug
// transport lives behind `--http` and is not wired in this build.
//
// Contract with .mcp.json: the subprocess stays alive until Claude
// Code hangs up stdin; the process emits MCP JSON-RPC on stdout. Any
// human-readable diagnostics MUST go to stderr; contaminating stdout
// breaks the MCP frame.

export async function serve(args: string[]): Promise<number> {
  const agentName = args[0];
  if (!agentName) {
    process.stderr.write(
      [
        'leash serve: missing agent name.',
        '',
        'Usage: leash serve <agent>',
        '',
        'Tip: Claude Code launches this from .mcp.json — you rarely run it by hand.',
        '     Run `leash status` to see registered agents.',
      ].join('\n') + '\n',
    );
    return 2;
  }

  const cwd = process.cwd();
  const leashRoot = resolve(cwd, '.leash');

  let handle: LeashMcpServerHandle;
  try {
    handle = await serveStdio({
      agentName,
      cwd,
      noUpstreams: shouldSkipUpstreams(),
      // Honour the platform-aware store picker so macOS users
      // actually get Keychain-backed keys. Non-darwin (and
      // LEASH_KEY_STORE=file) falls back to FileSessionKeyStore.
      sessionKeys: pickSessionKeyStore({ leashRoot }),
    });
  } catch (err) {
    process.stderr.write(
      `leash serve ${agentName}: startup failed — ${(err as Error).message}\n`,
    );
    return 1;
  }

  // Keep the event loop alive until stdin closes. Graceful shutdown
  // on SIGINT / SIGTERM / stdin close so the SQLite DB closes cleanly
  // on Claude Code's session teardown.
  const shutdown = () => {
    try {
      handle.close();
    } catch {
      /* best-effort */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);

  return new Promise<number>(() => {
    /* never resolves — stdio server owns the process */
  });
}

function shouldSkipUpstreams(): boolean {
  return (
    process.env.LEASH_NO_UPSTREAMS === '1' ||
    process.env.LEASH_NO_UPSTREAMS === 'true'
  );
}
