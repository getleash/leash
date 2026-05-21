import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';

// ─── Session-key store ──────────────────────────────────────────────
//
// Ships one impl: FileSessionKeyStore, backed by a plain JSON
// file at `.leash/agent/<name>/session-key.json`. macOS Keychain
// integration — which install.md + architecture.md both promise —
// lands with the CLI, behind the same SessionKeyStore
// interface so consumer code doesn't change.
//
// Deliberate simplifications for MVP:
// - No caching — unseal is file-read latency, order of hundreds of μs,
//   not worth the invalidation logic.
// - No integrity signature on the stored file. If an attacker can
//   write into `.leash/`, the whole topology is compromised; the
//   Keychain migration is where that threat model tightens.
// - Private keys never leave this process. Returned as a
//   PrivateKeyAccount so the caller signs but never sees the raw hex.

export interface SessionKeyStore {
  /** Unseal and return an account usable for signMessage / signTypedData / sign. */
  loadAgentKey(agentName: string): PrivateKeyAccount;
  /** Unseal the hub owner key. Same interface, different role. */
  loadHubOwnerKey(): PrivateKeyAccount;
  /**
   * Return the raw 0x-prefixed private key for the given agent.
   * Separate from loadAgentKey because most callers should never see
   * the raw hex — the exception is `leash export-backup`, which
   * re-serializes key material into the encrypted bundle. See
   * summary/open-questions.md for the Keychain-sealed-backup
   * followup.
   */
  loadRawAgentKey(agentName: string): Hex;
  loadRawHubOwnerKey(): Hex;
}

export class SessionKeyStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionKeyStoreError';
  }
}

export interface FileStoreOptions {
  /** The `.leash/` root. Same concept as AgentRuntime.leashRoot. */
  leashRoot: string;
}

interface SessionKeyFileShape {
  /** Hex-encoded private key, 0x-prefixed, 32 bytes. */
  privateKey: Hex;
  /** Corresponding address — cross-checked against agent.sessionKey to catch drift. */
  address: Address;
}

interface HubOwnerFileShape {
  privateKey: Hex;
  address: Address;
}

/**
 * File-backed store that reads the session-key JSON at
 * `.leash/agent/<name>/session-key.json` and the hub-owner JSON at
 * `.leash/hub-owner.json`.
 *
 * Not intended to ship to end users in MVP — the CLI's
 * `leash apply` will swap this out for the Keychain-backed store.
 * Tests use this directly; dev-mainnet runs too.
 */
export class FileSessionKeyStore implements SessionKeyStore {
  constructor(private readonly opts: FileStoreOptions) {}

  loadAgentKey(agentName: string): PrivateKeyAccount {
    const path = resolve(this.opts.leashRoot, 'agent', agentName, 'session-key.json');
    return this.readAccount(path, `agent ${agentName}`);
  }

  loadHubOwnerKey(): PrivateKeyAccount {
    const path = resolve(this.opts.leashRoot, 'hub-owner.json');
    return this.readAccount(path, 'hub owner');
  }

  loadRawAgentKey(agentName: string): Hex {
    const path = resolve(this.opts.leashRoot, 'agent', agentName, 'session-key.json');
    return this.readRaw(path, `agent ${agentName}`);
  }

  loadRawHubOwnerKey(): Hex {
    const path = resolve(this.opts.leashRoot, 'hub-owner.json');
    return this.readRaw(path, 'hub owner');
  }

  private readRaw(path: string, role: string): Hex {
    if (!existsSync(path)) {
      throw new SessionKeyStoreError(`${role} key file missing at ${path}.`);
    }
    const raw = JSON.parse(readFileSync(path, 'utf8')) as SessionKeyFileShape;
    if (!raw.privateKey || !raw.privateKey.startsWith('0x') || raw.privateKey.length !== 66) {
      throw new SessionKeyStoreError(
        `${role} key file at ${path} missing well-formed privateKey`,
      );
    }
    return raw.privateKey;
  }

  private readAccount(path: string, role: string): PrivateKeyAccount {
    if (!existsSync(path)) {
      throw new SessionKeyStoreError(
        `${role} key file missing at ${path}. ` +
          `The CLI will seed this; for dev, write ` +
          `{"privateKey":"0x...","address":"0x..."} manually.`,
      );
    }
    let raw: SessionKeyFileShape | HubOwnerFileShape;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8')) as SessionKeyFileShape;
    } catch (e) {
      throw new SessionKeyStoreError(
        `${role} key file at ${path} is not valid JSON: ${(e as Error).message}`,
      );
    }
    if (!raw.privateKey || !raw.privateKey.startsWith('0x')) {
      throw new SessionKeyStoreError(
        `${role} key file at ${path} missing privateKey (0x-prefixed hex)`,
      );
    }
    const account = privateKeyToAccount(raw.privateKey);
    if (raw.address && account.address.toLowerCase() !== raw.address.toLowerCase()) {
      throw new SessionKeyStoreError(
        `${role} key file at ${path}: derived address ${account.address} ` +
          `does not match stored address ${raw.address}`,
      );
    }
    return account;
  }
}
