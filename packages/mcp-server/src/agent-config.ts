import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Address } from 'viem';
import {
  type ChainName,
  type ChainConfig,
  type SignedAuthorizationGrant,
  getChainConfig,
} from '@getleash/core';

// ─── On-disk layout ──────────────────────────────────────────────────
//
// The CLI writes these files during `leash apply`. The MCP server
// reads (but never writes) them at startup.
//
//   ${cwd}/.leash/
//   ├── config.json            — hub-level (ownerAddress, hubAddress, chain)
//   └── agent/<name>/
//       ├── agent.json         — sub-account address, session-key pubkey, policy path
//       ├── grant.json         — SignedAuthorizationGrant (Phase 5.5 object)
//       └── session-key.enc    — encrypted session-key private key (Keychain unseal)
//
// Phase 6a reads the first three. Session-key decryption lives in
// Phase 6b when write tools come online.

export interface LeashHubConfig {
  owner: Address;
  hub: Address;
  chain: ChainName;
}

export interface LeashAgentRecord {
  name: string;
  subAccount: Address;
  /** Session-key pubkey (secret is in session-key.enc). */
  sessionKey: Address;
  /** Path to the policy markdown that produced this agent. */
  policyPath: string;
}

/**
 * What the MCP server carries around per run. Built by `loadAgentRuntime`
 * and passed into every tool handler.
 */
export interface AgentRuntime {
  agentName: string;
  hub: LeashHubConfig;
  agent: LeashAgentRecord;
  signedGrant: SignedAuthorizationGrant;
  chainConfig: ChainConfig;
  /** Resolved .leash/ root (the directory the CLI wrote into). */
  leashRoot: string;
}

export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentConfigError';
  }
}

// ─── Loader ──────────────────────────────────────────────────────────

export interface LoadAgentRuntimeParams {
  agentName: string;
  /** Directory that contains `.leash/`. Defaults to process.cwd(). */
  cwd?: string;
}

export function loadAgentRuntime({
  agentName,
  cwd = process.cwd(),
}: LoadAgentRuntimeParams): AgentRuntime {
  const leashRoot = resolve(cwd, '.leash');
  if (!existsSync(leashRoot)) {
    throw new AgentConfigError(
      `no .leash/ directory under ${cwd} — run \`leash apply <policy>.md\` first`,
    );
  }

  const hub = readJson<LeashHubConfig>(resolve(leashRoot, 'config.json'), 'config.json');
  const agentDir = resolve(leashRoot, 'agent', agentName);
  if (!existsSync(agentDir)) {
    throw new AgentConfigError(
      `no agent '${agentName}' under ${leashRoot}/agent/ — ` +
        `run \`leash apply ${agentName}-policy.md\` first`,
    );
  }
  const agent = readJson<LeashAgentRecord>(
    resolve(agentDir, 'agent.json'),
    `agent/${agentName}/agent.json`,
  );
  const signedGrant = readJson<SignedAuthorizationGrant>(
    resolve(agentDir, 'grant.json'),
    `agent/${agentName}/grant.json`,
    reviveGrantBigints,
  );

  // Sanity: the three files must agree on identity. Catching drift
  // here surfaces it before any tool runs.
  if (agent.name !== agentName) {
    throw new AgentConfigError(
      `agent.json says name='${agent.name}' but was loaded as '${agentName}'`,
    );
  }
  if (signedGrant.grant.subAccount.toLowerCase() !== agent.subAccount.toLowerCase()) {
    throw new AgentConfigError(
      `grant.subAccount (${signedGrant.grant.subAccount}) does not match ` +
        `agent.json subAccount (${agent.subAccount})`,
    );
  }
  if (signedGrant.grant.chain !== hub.chain) {
    throw new AgentConfigError(
      `grant.chain (${signedGrant.grant.chain}) does not match hub.chain (${hub.chain})`,
    );
  }

  return {
    agentName,
    hub,
    agent,
    signedGrant,
    chainConfig: getChainConfig(hub.chain),
    leashRoot,
  };
}

// ─── helpers ─────────────────────────────────────────────────────────

function readJson<T>(
  path: string,
  relName: string,
  reviver?: (key: string, value: unknown) => unknown,
): T {
  if (!existsSync(path)) {
    throw new AgentConfigError(`missing .leash/${relName}`);
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new AgentConfigError(
      `cannot read .leash/${relName}: ${(e as Error).message}`,
    );
  }
  try {
    return JSON.parse(raw, reviver as any) as T;
  } catch (e) {
    throw new AgentConfigError(
      `.leash/${relName} is not valid JSON: ${(e as Error).message}`,
    );
  }
}

/**
 * JSON.parse reviver that restores bigint fields inside grant.limits.
 * The writer (`leash apply`) serializes them as decimal strings.
 */
function reviveGrantBigints(key: string, value: unknown): unknown {
  if (
    typeof value === 'string' &&
    (key === 'maxPerTransaction' ||
      key === 'daily' ||
      key === 'weekly' ||
      key === 'monthly')
  ) {
    return BigInt(value);
  }
  return value;
}
