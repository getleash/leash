import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  type SessionKeyStore,
  SessionKeyStoreError,
} from '@getleash/mcp-server';

// ─── macOS Keychain-backed session-key store ─────────────────────────
//
// Uses Apple's `security` CLI. Service: `com.leash`. Accounts:
//   - `leash-hub-owner`                  → hub owner ECDSA key
//   - `leash-agent-<name>-session-key`   → per-agent session key
//
// Values stored are the 0x-prefixed private key hex. The matching
// address is re-derived via viem on read, so a compromised Keychain
// entry still gets caught by the agent-config cross-check
// (agent.sessionKey !== derived address → refuse to proceed).
//
// Non-macOS platforms should not use this store — the CLI picks
// FileSessionKeyStore as a fallback (see src/stores/index.ts).

const SERVICE = 'com.leash';
const HUB_OWNER_ACCOUNT = 'leash-hub-owner';
const agentAccount = (name: string) => `leash-agent-${name}-session-key`;

export class KeychainSessionKeyStore implements SessionKeyStore {
  constructor() {
    if (platform() !== 'darwin') {
      throw new SessionKeyStoreError(
        'KeychainSessionKeyStore requires macOS — use FileSessionKeyStore elsewhere',
      );
    }
  }

  loadAgentKey(agentName: string): PrivateKeyAccount {
    return this.readAccount(agentAccount(agentName), `agent ${agentName}`);
  }

  loadHubOwnerKey(): PrivateKeyAccount {
    return this.readAccount(HUB_OWNER_ACCOUNT, 'hub owner');
  }

  loadRawAgentKey(agentName: string): Hex {
    return this.readRaw(agentAccount(agentName), `agent ${agentName}`);
  }

  loadRawHubOwnerKey(): Hex {
    return this.readRaw(HUB_OWNER_ACCOUNT, 'hub owner');
  }

  private readRaw(account: string, role: string): Hex {
    let raw: string;
    try {
      raw = execFileSync(
        '/usr/bin/security',
        ['find-generic-password', '-s', SERVICE, '-a', account, '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim();
    } catch {
      throw new SessionKeyStoreError(
        `${role} key not found in macOS Keychain under service=${SERVICE} account=${account}.`,
      );
    }
    if (!raw.startsWith('0x') || raw.length !== 66) {
      throw new SessionKeyStoreError(
        `${role} key in Keychain is not a well-formed 0x-prefixed 32-byte hex`,
      );
    }
    return raw as Hex;
  }

  /**
   * Store a private key in the Keychain under the given account.
   * Overwrites an existing entry with the same (service, account)
   * pair. Exposed for `leash apply` and `leash import-backup`.
   */
  setAgentKey(agentName: string, privateKey: Hex): void {
    this.writeAccount(agentAccount(agentName), privateKey);
  }

  setHubOwnerKey(privateKey: Hex): void {
    this.writeAccount(HUB_OWNER_ACCOUNT, privateKey);
  }

  /** Delete an entry. Safe on non-existent entries. */
  deleteAgentKey(agentName: string): void {
    this.deleteAccount(agentAccount(agentName));
  }

  // ─── private ───────────────────────────────────────────────────

  private readAccount(account: string, role: string): PrivateKeyAccount {
    let raw: string;
    try {
      // -w returns only the password; stderr carries the prompt on first access.
      raw = execFileSync(
        '/usr/bin/security',
        ['find-generic-password', '-s', SERVICE, '-a', account, '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim();
    } catch (e) {
      throw new SessionKeyStoreError(
        `${role} key not found in macOS Keychain under service=${SERVICE} account=${account}. ` +
          `Run \`leash apply\` to seed it.`,
      );
    }
    if (!raw.startsWith('0x')) {
      throw new SessionKeyStoreError(
        `${role} key in Keychain is not 0x-prefixed — entry looks corrupted`,
      );
    }
    return privateKeyToAccount(raw as Hex);
  }

  private writeAccount(account: string, privateKey: Hex): void {
    if (!privateKey.startsWith('0x') || privateKey.length !== 66) {
      throw new SessionKeyStoreError(
        `refusing to write malformed private key to Keychain`,
      );
    }
    // Best-effort delete first so `add` doesn't fail on duplicates;
    // `-U` would also work but is macOS-version-dependent.
    this.deleteAccount(account);
    try {
      execFileSync(
        '/usr/bin/security',
        [
          'add-generic-password',
          '-s', SERVICE,
          '-a', account,
          '-w', privateKey,
          '-U',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (e) {
      throw new SessionKeyStoreError(
        `failed to write ${account} to Keychain: ${(e as Error).message}`,
      );
    }
  }

  private deleteAccount(account: string): void {
    try {
      execFileSync(
        '/usr/bin/security',
        ['delete-generic-password', '-s', SERVICE, '-a', account],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      // Not-found is the typical case; no-op.
    }
  }
}

// ─── Optional helper: check if the derived address matches agent config ──

export function assertAddressMatches(
  account: PrivateKeyAccount,
  expected: Address,
  role: string,
): void {
  if (account.address.toLowerCase() !== expected.toLowerCase()) {
    throw new SessionKeyStoreError(
      `${role} key in Keychain derives to ${account.address}, expected ${expected}. ` +
        `Entry may be stale or tampered — re-run \`leash apply\` to re-seed.`,
    );
  }
}
