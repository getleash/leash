import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { argon2id } from 'hash-wasm';

// ─── Encrypted-backup codec ──────────────────────────────────────────
//
// AES-256-GCM with Argon2id KDF, per summary/errors.md (the backup
// format the user-flows + error matrix pinned). Designed so a
// backup file is a single self-describing blob:
//
//   [0:8]     magic = "LEASH\x00\x01\x00"  (version 1, subversion 0)
//   [8:24]    Argon2id salt (16B)
//   [24:36]   AES-GCM nonce (12B)
//   [36:52]   AES-GCM tag (16B, appended to ciphertext below but
//             moved into the header for a streaming-friendlier read)
//   [52:]     ciphertext
//
// Actually: Node's crypto GCM appends the tag separately via
// getAuthTag/setAuthTag, not interleaved with ciphertext. We store
// the tag in the header so decryption can verify before consuming
// any ciphertext bytes.

const MAGIC = Buffer.from([0x4c, 0x45, 0x41, 0x53, 0x48, 0x00, 0x01, 0x00]); // LEASH\0\1\0
const SALT_LEN = 16;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32; // AES-256
const HEADER_LEN = MAGIC.length + SALT_LEN + NONCE_LEN + TAG_LEN;

// Argon2id params — conservative-but-not-obnoxious for a laptop.
// ~1 second on Apple M-series at these params; adjust upward as
// hardware improves.
const ARGON_ITERATIONS = 3;
const ARGON_MEMORY_KIB = 64 * 1024; // 64 MB
const ARGON_PARALLELISM = 1;

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

// ─── Encrypt ─────────────────────────────────────────────────────────

export async function encryptBackup(
  plaintext: Buffer,
  password: string,
): Promise<Buffer> {
  if (password.length === 0) {
    throw new BackupError('refusing to encrypt with an empty password');
  }
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const key = await deriveKey(password, salt);

  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_LEN) {
    throw new BackupError(`unexpected GCM tag length: ${tag.length}`);
  }

  return Buffer.concat([MAGIC, salt, nonce, tag, ciphertext]);
}

// ─── Decrypt ─────────────────────────────────────────────────────────

export async function decryptBackup(
  blob: Buffer,
  password: string,
): Promise<Buffer> {
  if (blob.length < HEADER_LEN) {
    throw new BackupError('backup file truncated (shorter than the header)');
  }
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BackupError(
      'backup magic mismatch — file is not a Leash backup (or was written by a future version)',
    );
  }
  let off = MAGIC.length;
  const salt = blob.subarray(off, off + SALT_LEN);
  off += SALT_LEN;
  const nonce = blob.subarray(off, off + NONCE_LEN);
  off += NONCE_LEN;
  const tag = blob.subarray(off, off + TAG_LEN);
  off += TAG_LEN;
  const ciphertext = blob.subarray(off);

  const key = await deriveKey(password, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (e) {
    // GCM `final()` throws on tag mismatch. Translate to the
    // canonical Argon2id-verify-failed message from errors.md §
    // "import-backup".
    throw new BackupError(
      'password incorrect (Argon2id/AES-GCM verify failed)',
    );
  }
}

// ─── KDF ─────────────────────────────────────────────────────────────

async function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  const hex = await argon2id({
    password,
    salt,
    parallelism: ARGON_PARALLELISM,
    iterations: ARGON_ITERATIONS,
    memorySize: ARGON_MEMORY_KIB,
    hashLength: KEY_LEN,
    outputType: 'hex',
  });
  return Buffer.from(hex, 'hex');
}

/**
 * KDF params (exported so tests can document the chosen ceiling).
 * Values baked into each blob's ciphertext via the tag — changing
 * these here changes the decrypt result and will invalidate
 * existing backups. Blob version bump required to evolve them.
 */
export const BACKUP_PARAMS = {
  magic: MAGIC.toString('hex'),
  saltLen: SALT_LEN,
  nonceLen: NONCE_LEN,
  tagLen: TAG_LEN,
  keyLen: KEY_LEN,
  argonIterations: ARGON_ITERATIONS,
  argonMemoryKib: ARGON_MEMORY_KIB,
  argonParallelism: ARGON_PARALLELISM,
} as const;
