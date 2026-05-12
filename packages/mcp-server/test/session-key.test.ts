import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  FileSessionKeyStore,
  SessionKeyStoreError,
} from '../src/session-key.js';

// Known test key (Anvil #0). Public, deterministic — do NOT use it for value.
const TEST_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDR = privateKeyToAccount(TEST_PK).address;

describe('FileSessionKeyStore', () => {
  let dir: string;
  let leashRoot: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'leash-keys-'));
    leashRoot = resolve(dir, '.leash');
    mkdirSync(resolve(leashRoot, 'agent', 'cryptonit'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads an agent session-key file and returns a usable account', () => {
    writeFileSync(
      resolve(leashRoot, 'agent', 'cryptonit', 'session-key.json'),
      JSON.stringify({ privateKey: TEST_PK, address: TEST_ADDR }),
    );
    const store = new FileSessionKeyStore({ leashRoot });
    const account = store.loadAgentKey('cryptonit');
    expect(account.address).toBe(TEST_ADDR);
  });

  it('loads the hub-owner key from the leash root', () => {
    writeFileSync(
      resolve(leashRoot, 'hub-owner.json'),
      JSON.stringify({ privateKey: TEST_PK, address: TEST_ADDR }),
    );
    const store = new FileSessionKeyStore({ leashRoot });
    expect(store.loadHubOwnerKey().address).toBe(TEST_ADDR);
  });

  it('throws a clear error if the agent key file is missing', () => {
    const store = new FileSessionKeyStore({ leashRoot });
    expect(() => store.loadAgentKey('cryptonit')).toThrow(
      SessionKeyStoreError,
    );
    expect(() => store.loadAgentKey('cryptonit')).toThrow(
      /agent cryptonit key file missing/,
    );
  });

  it('rejects a file whose stored address disagrees with the private key', () => {
    writeFileSync(
      resolve(leashRoot, 'agent', 'cryptonit', 'session-key.json'),
      JSON.stringify({
        privateKey: TEST_PK,
        address: '0x0000000000000000000000000000000000000099',
      }),
    );
    const store = new FileSessionKeyStore({ leashRoot });
    expect(() => store.loadAgentKey('cryptonit')).toThrow(
      /does not match stored address/,
    );
  });

  it('rejects malformed JSON', () => {
    writeFileSync(
      resolve(leashRoot, 'agent', 'cryptonit', 'session-key.json'),
      '{not json',
    );
    const store = new FileSessionKeyStore({ leashRoot });
    expect(() => store.loadAgentKey('cryptonit')).toThrow(SessionKeyStoreError);
  });

  it('rejects a file missing the privateKey field', () => {
    writeFileSync(
      resolve(leashRoot, 'agent', 'cryptonit', 'session-key.json'),
      JSON.stringify({ address: TEST_ADDR }),
    );
    const store = new FileSessionKeyStore({ leashRoot });
    expect(() => store.loadAgentKey('cryptonit')).toThrow(
      /missing privateKey/,
    );
  });
});
