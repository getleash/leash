import { describe, expect, it } from 'vitest';
import {
  BACKUP_PARAMS,
  BackupError,
  decryptBackup,
  encryptBackup,
} from '../src/backup/codec.js';

describe('backup codec round-trip', () => {
  it('encrypt → decrypt returns the original bytes', async () => {
    const plaintext = Buffer.from('the quick brown fox jumps over 0x1337', 'utf8');
    const blob = await encryptBackup(plaintext, 'hunter2-with-some-length');
    const roundTripped = await decryptBackup(blob, 'hunter2-with-some-length');
    expect(roundTripped.equals(plaintext)).toBe(true);
  });

  it('encrypting the same plaintext twice produces different blobs (salt + nonce randomness)', async () => {
    const a = await encryptBackup(Buffer.from('same bytes'), 'same password');
    const b = await encryptBackup(Buffer.from('same bytes'), 'same password');
    expect(a.equals(b)).toBe(false);
  });

  it('wrong password rejects with the canonical "Argon2id/AES-GCM verify failed" message', async () => {
    const blob = await encryptBackup(Buffer.from('secret'), 'correct');
    await expect(decryptBackup(blob, 'wrong')).rejects.toThrow(
      /Argon2id\/AES-GCM verify failed/,
    );
  });

  it('refuses to encrypt with an empty password', async () => {
    await expect(encryptBackup(Buffer.from('x'), '')).rejects.toThrow(BackupError);
  });

  it('rejects a truncated file', async () => {
    await expect(decryptBackup(Buffer.alloc(8), 'pw')).rejects.toThrow(
      /truncated/,
    );
  });

  it('rejects a file with the wrong magic', async () => {
    const blob = Buffer.concat([Buffer.alloc(BACKUP_PARAMS.nonceLen + BACKUP_PARAMS.saltLen + BACKUP_PARAMS.tagLen + 16), Buffer.from('whatever')]);
    await expect(decryptBackup(blob, 'pw')).rejects.toThrow(/magic mismatch/);
  });

  it('pins the KDF + cipher parameters (blob-format version guard)', () => {
    // Regression guard. Changing any of these invalidates existing
    // backups; a version bump is mandatory before adjusting.
    expect(BACKUP_PARAMS.keyLen).toBe(32);
    expect(BACKUP_PARAMS.saltLen).toBe(16);
    expect(BACKUP_PARAMS.nonceLen).toBe(12);
    expect(BACKUP_PARAMS.tagLen).toBe(16);
    expect(BACKUP_PARAMS.argonIterations).toBeGreaterThanOrEqual(3);
    expect(BACKUP_PARAMS.argonMemoryKib).toBeGreaterThanOrEqual(32 * 1024);
    // Magic should start with "LEASH".
    expect(BACKUP_PARAMS.magic.slice(0, 10).toUpperCase()).toBe('4C45415348');
  });
});
