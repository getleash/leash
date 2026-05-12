import { describe, expect, it, vi } from 'vitest';
import { platform } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import {
  FileSessionKeyStore,
  KeychainSessionKeyStore,
  pickSessionKeyStore,
} from '../src/stores/index.js';

const TEST_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDR = privateKeyToAccount(TEST_PK).address;

describe('pickSessionKeyStore', () => {
  it('honours LEASH_KEY_STORE=file even on macOS', () => {
    const before = process.env.LEASH_KEY_STORE;
    process.env.LEASH_KEY_STORE = 'file';
    try {
      const s = pickSessionKeyStore({ leashRoot: '/tmp/leash' });
      expect(s).toBeInstanceOf(FileSessionKeyStore);
    } finally {
      if (before === undefined) delete process.env.LEASH_KEY_STORE;
      else process.env.LEASH_KEY_STORE = before;
    }
  });

  it('picks Keychain on darwin by default', () => {
    const before = process.env.LEASH_KEY_STORE;
    delete process.env.LEASH_KEY_STORE;
    try {
      const s = pickSessionKeyStore({ leashRoot: '/tmp/leash' });
      if (platform() === 'darwin') {
        expect(s).toBeInstanceOf(KeychainSessionKeyStore);
      } else {
        expect(s).toBeInstanceOf(FileSessionKeyStore);
      }
    } finally {
      if (before !== undefined) process.env.LEASH_KEY_STORE = before;
    }
  });
});

describe('KeychainSessionKeyStore constructor guard', () => {
  it('refuses to instantiate on non-macOS', () => {
    if (platform() === 'darwin') {
      return; // Can't test the guard on the very platform it's for.
    }
    expect(() => new KeychainSessionKeyStore()).toThrow(/requires macOS/);
  });
});

describe('FileSessionKeyStore via stores/index re-export', () => {
  it('loads a hub-owner key file and returns a usable account', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'leash-cli-'));
    const leashRoot = resolve(dir, '.leash');
    mkdirSync(leashRoot, { recursive: true });
    try {
      writeFileSync(
        resolve(leashRoot, 'hub-owner.json'),
        JSON.stringify({ privateKey: TEST_PK, address: TEST_ADDR }),
      );
      const store = new FileSessionKeyStore({ leashRoot });
      expect(store.loadHubOwnerKey().address).toBe(TEST_ADDR);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
