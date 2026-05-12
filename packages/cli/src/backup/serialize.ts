import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Address, Hex } from 'viem';
import type { SessionKeyStore } from '@getleash/mcp-server';

// ─── Backup bundle shape ─────────────────────────────────────────────
//
// Flat JSON object (encrypted as one AES-GCM-sealed blob). Holds
// EVERYTHING needed to reconstitute a .leash/ tree on another machine:
// config, hub owner key, one entry per agent (metadata + grant +
// session key + policy markdown + SQLite dump as base64).
//
// No on-chain state gets snapshotted — addresses alone are the
// reconstruction anchor, everything else derives or re-reads from
// chain after import.
//
// Design note (MVP limitation, tracked in summary/open-questions.md):
// on macOS the Keychain-sealed keys are re-serialized into the
// bundle in plain hex. The backup re-seeds them into the Keychain
// on import. A future version should support exporting to a
// keychain-scoped format (e.g. Apple-only .keychain bundle) that
// stays sealed end-to-end.

export const BACKUP_VERSION = 1;

export interface BackupAgent {
  name: string;
  /** Contents of .leash/agent/<name>/agent.json. */
  agentJson: Record<string, unknown>;
  /** Contents of .leash/agent/<name>/grant.json. */
  grantJson: Record<string, unknown>;
  /** Session-key private key (re-serialized from Keychain/file). */
  sessionKey: { address: Address; privateKey: Hex };
  /** Policy markdown — keeps the policyHash verifiable. */
  policyMd?: string;
  /** Base64-encoded SQLite payment-log snapshot. Optional — not every agent has txs yet. */
  paymentLogBase64?: string;
}

export interface BackupBundle {
  version: number;
  /** Contents of .leash/config.json. */
  config: Record<string, unknown>;
  /** Hub owner key — re-serialized from the store. */
  hubOwner: { address: Address; privateKey: Hex };
  agents: BackupAgent[];
}

// ─── Build bundle from .leash/ ───────────────────────────────────────

export interface SerializeParams {
  leashRoot: string;
  sessionKeys: SessionKeyStore;
}

export function serializeLeashDir(params: SerializeParams): BackupBundle {
  const { leashRoot, sessionKeys } = params;
  if (!existsSync(leashRoot)) {
    throw new Error(`no .leash/ at ${leashRoot}`);
  }
  const configPath = resolve(leashRoot, 'config.json');
  if (!existsSync(configPath)) {
    throw new Error(`missing ${configPath}`);
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<
    string,
    unknown
  >;
  const hubOwnerAccount = sessionKeys.loadHubOwnerKey();
  const hubOwnerPrivateKey = sessionKeys.loadRawHubOwnerKey();

  const agentsDir = resolve(leashRoot, 'agent');
  const agents: BackupAgent[] = [];
  if (existsSync(agentsDir)) {
    for (const name of readdirSync(agentsDir)) {
      const dir = resolve(agentsDir, name);
      if (!statSync(dir).isDirectory()) continue;
      const agentJsonPath = resolve(dir, 'agent.json');
      const grantJsonPath = resolve(dir, 'grant.json');
      if (!existsSync(agentJsonPath) || !existsSync(grantJsonPath)) continue;
      const agentJson = JSON.parse(readFileSync(agentJsonPath, 'utf8')) as Record<
        string,
        unknown
      >;
      const grantJson = JSON.parse(readFileSync(grantJsonPath, 'utf8')) as Record<
        string,
        unknown
      >;
      const sessionKeyAccount = sessionKeys.loadAgentKey(name);
      const sessionKeyPrivate = sessionKeys.loadRawAgentKey(name);
      const policyMdPath = resolve(dir, 'policy.md');
      const policyMd = existsSync(policyMdPath)
        ? readFileSync(policyMdPath, 'utf8')
        : undefined;
      const dbPath = resolve(dir, 'leash.db');
      const paymentLogBase64 = existsSync(dbPath)
        ? readFileSync(dbPath).toString('base64')
        : undefined;
      agents.push({
        name,
        agentJson,
        grantJson,
        sessionKey: {
          address: sessionKeyAccount.address,
          privateKey: sessionKeyPrivate,
        },
        policyMd,
        paymentLogBase64,
      });
    }
  }

  return {
    version: BACKUP_VERSION,
    config,
    hubOwner: {
      address: hubOwnerAccount.address,
      privateKey: hubOwnerPrivateKey,
    },
    agents,
  };
}
