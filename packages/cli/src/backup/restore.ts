import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import {
  FileSessionKeyStore,
  KeychainSessionKeyStore,
} from '../stores/index.js';
import { pickSessionKeyStore } from '../stores/index.js';
import type { BackupBundle } from './serialize.js';

// ─── Restore a decrypted BackupBundle into a .leash/ tree ────────────
//
// Writes config.json, all agent.json / grant.json / policy.md /
// leash.db files, and re-seeds the chosen key store. On macOS the
// Keychain is re-populated; on other platforms (or LEASH_KEY_STORE=file)
// the `.leash/hub-owner.json` + `.leash/agent/<name>/session-key.json`
// files are written.
//
// Refuses to clobber an existing .leash/ tree — the user must
// explicitly clear it first. Prevents overwriting a working setup.

export interface RestoreResult {
  agentCount: number;
  /** Which store implementation was actually used. */
  storeKind: 'keychain' | 'file';
}

export interface RestoreParams {
  bundle: BackupBundle;
  leashRoot: string;
  /** Forces the file-backed store even on macOS. Default false. */
  forceFileStore?: boolean;
}

export async function restoreLeashDir(
  params: RestoreParams,
): Promise<RestoreResult> {
  const { bundle, leashRoot } = params;
  if (existsSync(leashRoot)) {
    throw new Error(
      `${leashRoot} already exists. Move or remove it before import — Leash will ` +
        `not overwrite a live configuration.`,
    );
  }
  mkdirSync(leashRoot, { recursive: true });
  writeFileSync(
    resolve(leashRoot, 'config.json'),
    JSON.stringify(bundle.config, null, 2),
  );

  // Pick the store the user's platform would normally get, unless
  // they asked otherwise.
  const savedEnv = process.env.LEASH_KEY_STORE;
  if (params.forceFileStore) process.env.LEASH_KEY_STORE = 'file';
  try {
    const store = pickSessionKeyStore({ leashRoot });
    const storeKind: 'keychain' | 'file' =
      store instanceof KeychainSessionKeyStore ? 'keychain' : 'file';

    if (store instanceof KeychainSessionKeyStore) {
      store.setHubOwnerKey(bundle.hubOwner.privateKey);
    } else if (store instanceof FileSessionKeyStore) {
      writeFileSync(
        resolve(leashRoot, 'hub-owner.json'),
        JSON.stringify(
          { privateKey: bundle.hubOwner.privateKey, address: bundle.hubOwner.address },
          null,
          2,
        ),
      );
    } else {
      throw new Error('unsupported session-key store — cannot restore hub owner key');
    }

    for (const a of bundle.agents) {
      const dir = resolve(leashRoot, 'agent', a.name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        resolve(dir, 'agent.json'),
        JSON.stringify(a.agentJson, null, 2),
      );
      writeFileSync(
        resolve(dir, 'grant.json'),
        JSON.stringify(a.grantJson, null, 2),
      );
      if (a.policyMd) {
        writeFileSync(resolve(dir, 'policy.md'), a.policyMd);
      }
      if (a.paymentLogBase64) {
        writeFileSync(
          resolve(dir, 'leash.db'),
          Buffer.from(a.paymentLogBase64, 'base64'),
        );
      }
      if (store instanceof KeychainSessionKeyStore) {
        store.setAgentKey(a.name, a.sessionKey.privateKey);
      } else if (store instanceof FileSessionKeyStore) {
        writeFileSync(
          resolve(dir, 'session-key.json'),
          JSON.stringify(
            {
              privateKey: a.sessionKey.privateKey,
              address: a.sessionKey.address,
            },
            null,
            2,
          ),
        );
      }
    }

    return { agentCount: bundle.agents.length, storeKind };
  } finally {
    if (savedEnv === undefined) delete process.env.LEASH_KEY_STORE;
    else process.env.LEASH_KEY_STORE = savedEnv;
  }
}

void dirname; // silence unused import for future-proof path helpers
