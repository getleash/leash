import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decryptBackup } from '../backup/codec.js';
import { promptPassword } from '../backup/password.js';
import { restoreLeashDir } from '../backup/restore.js';
import type { BackupBundle } from '../backup/serialize.js';

// ─── leash import-backup <path> ──────────────────────────────────────
//
// Opens an encrypted backup, prompts for the password, decrypts,
// and restores the bundle into `.leash/` under the current cwd.
// Refuses to clobber an existing `.leash/` — the user moves/deletes
// it first, so we never silently overwrite a live config.

export async function importBackup(args: string[]): Promise<number> {
  const src = args[0];
  if (!src) {
    process.stderr.write(
      [
        'leash import-backup: missing source path.',
        '',
        'Usage: leash import-backup <path>',
      ].join('\n') + '\n',
    );
    return 2;
  }
  const srcPath = resolve(src);
  const leashRoot = resolve(process.cwd(), '.leash');

  let blob: Buffer;
  try {
    blob = readFileSync(srcPath);
  } catch (e) {
    process.stderr.write(
      `leash import-backup: cannot read ${srcPath} — ${(e as Error).message}\n`,
    );
    return 2;
  }

  let password: string;
  try {
    password = await promptPassword({
      prompt: `Password for ${srcPath}: `,
      confirm: false,
    });
  } catch (e) {
    process.stderr.write(`leash import-backup: ${(e as Error).message}\n`);
    return 1;
  }

  process.stderr.write('Decrypting (Argon2id, 64 MB, ~1s)…\n');
  let plaintext: Buffer;
  try {
    plaintext = await decryptBackup(blob, password);
  } catch (e) {
    process.stderr.write(
      `leash import-backup: ${srcPath}: ${(e as Error).message}\n`,
    );
    return 1;
  }

  let bundle: BackupBundle;
  try {
    bundle = JSON.parse(plaintext.toString('utf8')) as BackupBundle;
  } catch (e) {
    process.stderr.write(
      `leash import-backup: decrypted payload is not valid JSON — ` +
        `${(e as Error).message}. The file may be corrupt.\n`,
    );
    return 1;
  }
  if (typeof bundle.version !== 'number') {
    process.stderr.write(
      'leash import-backup: bundle missing `version` — refusing to restore.\n',
    );
    return 1;
  }

  try {
    const res = await restoreLeashDir({ bundle, leashRoot });
    process.stdout.write(
      `  ✓ restored ${res.agentCount} agent(s) into ${leashRoot}\n` +
        `    key store: ${res.storeKind}\n`,
    );
    return 0;
  } catch (e) {
    process.stderr.write(
      `leash import-backup: ${(e as Error).message}\n`,
    );
    return 1;
  }
}
