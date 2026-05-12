import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { FileSessionKeyStore } from '@getleash/mcp-server';
import { decryptBackup, encryptBackup } from '../src/backup/codec.js';
import { serializeLeashDir, type BackupBundle } from '../src/backup/serialize.js';
import { restoreLeashDir } from '../src/backup/restore.js';
import { makeLeashFixture, type LeashFixture } from './helpers.js';

// Forces the file-backed store on all platforms so this test works
// uniformly and never touches the macOS Keychain from CI.
const PREV_KEY_STORE = process.env.LEASH_KEY_STORE;

beforeEach(() => {
  process.env.LEASH_KEY_STORE = 'file';
});
afterEach(() => {
  if (PREV_KEY_STORE === undefined) delete process.env.LEASH_KEY_STORE;
  else process.env.LEASH_KEY_STORE = PREV_KEY_STORE;
});

describe('serialize → encrypt → decrypt → restore', () => {
  let src: LeashFixture;
  let destRoot: string;

  beforeEach(() => {
    src = makeLeashFixture();
    destRoot = mkdtempSync(resolve(tmpdir(), 'leash-restore-'));
  });

  afterEach(() => {
    rmSync(src.root, { recursive: true, force: true });
    rmSync(destRoot, { recursive: true, force: true });
  });

  it('round-trips a fixture .leash/ through a sealed blob', async () => {
    // 1. Read the source fixture.
    const store = new FileSessionKeyStore({ leashRoot: src.leashRoot });
    const bundle = serializeLeashDir({
      leashRoot: src.leashRoot,
      sessionKeys: store,
    });
    expect(bundle.version).toBe(1);
    expect(bundle.hubOwner.address).toBe(src.hubOwnerAddress);
    expect(bundle.agents).toHaveLength(1);
    expect(bundle.agents[0].name).toBe(src.agentName);
    expect(bundle.agents[0].sessionKey.address).toBe(src.sessionKeyAddress);

    // 2. Seal.
    const plaintext = Buffer.from(
      JSON.stringify(bundle, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
      'utf8',
    );
    const blob = await encryptBackup(plaintext, 'correct-password-42');

    // 3. Decrypt.
    const restored = await decryptBackup(blob, 'correct-password-42');
    const parsed = JSON.parse(restored.toString('utf8')) as BackupBundle;
    expect(parsed.hubOwner.address).toBe(src.hubOwnerAddress);
    expect(parsed.agents[0].sessionKey.privateKey).toBe(
      bundle.agents[0].sessionKey.privateKey,
    );

    // 4. Restore into a fresh leashRoot.
    const newLeashRoot = resolve(destRoot, '.leash');
    const result = await restoreLeashDir({
      bundle: parsed,
      leashRoot: newLeashRoot,
    });
    expect(result.agentCount).toBe(1);
    expect(result.storeKind).toBe('file');

    // 5. Verify on-disk artifacts match.
    expect(existsSync(resolve(newLeashRoot, 'config.json'))).toBe(true);
    expect(existsSync(resolve(newLeashRoot, 'hub-owner.json'))).toBe(true);
    expect(
      existsSync(resolve(newLeashRoot, 'agent', src.agentName, 'grant.json')),
    ).toBe(true);

    // Cross-check: the restored key store derives the same addresses.
    const restoredStore = new FileSessionKeyStore({ leashRoot: newLeashRoot });
    expect(restoredStore.loadHubOwnerKey().address).toBe(src.hubOwnerAddress);
    expect(restoredStore.loadAgentKey(src.agentName).address).toBe(
      src.sessionKeyAddress,
    );
  });

  it('restore refuses to clobber an existing .leash/', async () => {
    const store = new FileSessionKeyStore({ leashRoot: src.leashRoot });
    const bundle = serializeLeashDir({
      leashRoot: src.leashRoot,
      sessionKeys: store,
    });
    const existingRoot = resolve(destRoot, '.leash');
    mkdirSync(existingRoot, { recursive: true });
    await expect(
      restoreLeashDir({ bundle, leashRoot: existingRoot }),
    ).rejects.toThrow(/already exists/);
  });
});
