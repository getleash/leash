import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type Chain,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  http,
} from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import {
  AgentConfigError,
  PaymentLog,
  loadAgentRuntime,
  type AgentRuntime,
  type SessionKeyStore,
} from '@getleash/mcp-server';
import { pickSessionKeyStore } from './stores/index.js';

// ─── CLI runtime helpers ─────────────────────────────────────────────
//
// Thin layer on top of @getleash/mcp-server's loader: resolves .leash/,
// picks the right key store, builds clients. Commands (status, fund,
// drain, revoke, logs) consume this directly; serve goes through
// serveStdio which uses its own flavor.

export interface CliRuntime {
  agentName: string;
  runtime: AgentRuntime;
  publicClient: PublicClient;
  sessionKeys: SessionKeyStore;
}

export interface LoadCliRuntimeParams {
  agentName: string;
  cwd?: string;
}

export function loadCliRuntime(params: LoadCliRuntimeParams): CliRuntime {
  const cwd = params.cwd ?? process.cwd();
  const runtime = loadAgentRuntime({ agentName: params.agentName, cwd });
  const publicClient = createPublicClient({
    chain: runtime.chainConfig.chain as Chain,
    transport: http(resolveRpcUrl(runtime)),
  });
  const sessionKeys = pickSessionKeyStore({ leashRoot: runtime.leashRoot });
  return {
    agentName: params.agentName,
    runtime,
    publicClient,
    sessionKeys,
  };
}

/** Build a wallet client signing as the given account, using the runtime's RPC. */
export function createRuntimeWalletClient(
  runtime: AgentRuntime,
  account: PrivateKeyAccount,
): WalletClient {
  return createWalletClient({
    chain: runtime.chainConfig.chain as Chain,
    transport: http(resolveRpcUrl(runtime)),
    account,
  });
}

/**
 * Open the payment log for a given agent runtime. Callers are
 * responsible for `.close()` — cli commands typically wrap in a
 * try/finally around the single call.
 */
export function openPaymentLog(runtime: AgentRuntime): PaymentLog {
  const dbPath = resolve(
    runtime.leashRoot,
    'agent',
    runtime.agentName,
    'leash.db',
  );
  return new PaymentLog(dbPath);
}

// ─── Agent listing ───────────────────────────────────────────────────

/**
 * Enumerate all agents under `.leash/agent/`. Used by `leash status`
 * (no argument form) and `leash doctor`.
 */
export function listAgentsOnDisk(cwd: string = process.cwd()): string[] {
  const agentDir = resolve(cwd, '.leash', 'agent');
  if (!existsSync(agentDir)) return [];
  return readdirSync(agentDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

// ─── RPC resolution ──────────────────────────────────────────────────
//
// Same precedence as the mcp-server's blockchain.ts: explicit env >
// public fallback. We keep two copies intentionally — the server
// module doesn't take a process.env dependency at import time, and
// the CLI's resolution is visible here.

const PUBLIC_RPC_FALLBACK: Record<string, string> = {
  base: 'https://mainnet.base.org',
  'base-sepolia': 'https://sepolia.base.org',
};

export function resolveRpcUrl(runtime: AgentRuntime): string {
  const env =
    runtime.chainConfig.name === 'base'
      ? process.env.LEASH_BASE_RPC
      : process.env.LEASH_BASE_SEPOLIA_RPC;
  return env ?? PUBLIC_RPC_FALLBACK[runtime.chainConfig.name] ?? PUBLIC_RPC_FALLBACK.base;
}

// ─── Friendly error wrappers ─────────────────────────────────────────

/**
 * Run a command body, translating the two most common
 * startup-configuration failures into short stderr lines + exit 2.
 * Anything else propagates.
 */
export async function runWithConfig(
  fn: () => Promise<number>,
): Promise<number> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AgentConfigError) {
      process.stderr.write(`leash: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}
