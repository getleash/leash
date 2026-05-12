import { platform } from 'node:os';
import {
  FileSessionKeyStore,
  type SessionKeyStore,
} from '@getleash/mcp-server';
import { KeychainSessionKeyStore } from './keychain.js';

// ─── Store selection ─────────────────────────────────────────────────
//
// macOS: Keychain-backed (the MVP promise in summary/install.md).
// Elsewhere: fall back to the FileSessionKeyStore from @getleash/mcp-server
//   (`.leash/hub-owner.json` + `.leash/agent/<name>/session-key.json`).
//
// An explicit `LEASH_KEY_STORE=file` env var forces the file backend
// even on macOS — useful for CI and for running inside a container
// that can't reach the host's Keychain.

export interface PickStoreParams {
  leashRoot: string;
}

export function pickSessionKeyStore(
  params: PickStoreParams,
): SessionKeyStore {
  if (process.env.LEASH_KEY_STORE === 'file') {
    return new FileSessionKeyStore({ leashRoot: params.leashRoot });
  }
  if (platform() === 'darwin') {
    return new KeychainSessionKeyStore();
  }
  return new FileSessionKeyStore({ leashRoot: params.leashRoot });
}

export { KeychainSessionKeyStore } from './keychain.js';
export { FileSessionKeyStore } from '@getleash/mcp-server';
