import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encryptBackup } from '../backup/codec.js';
import { promptPassword } from '../backup/password.js';
import { serializeLeashDir } from '../backup/serialize.js';
import { pickSessionKeyStore } from '../stores/index.js';

// ─── leash export-backup <path> ──────────────────────────────────────
//
// Reads the local .leash/ tree + the associated key material
// (Keychain on macOS, .leash/hub-owner.json + session-key.json
// elsewhere), bundles everything into one JSON object, and writes it
// as an Argon2id-AES-GCM sealed blob to the given path.
//
// Password prompt is interactive with a confirmation step —
// Argon2id's tuning means an unconfirmed typo could be unrecoverable
// once the .leash/ is gone. Confirmation catches typos before
// encryption, not after.

export async function exportBackup(args: string[]): Promise<number> {
  const out = args[0];
  if (!out) {
    process.stderr.write(
      [
        'leash export-backup: missing output path.',
        '',
        'Usage: leash export-backup <path>',
      ].join('\n') + '\n',
    );
    return 2;
  }
  const outPath = resolve(out);
  const leashRoot = resolve(process.cwd(), '.leash');

  let bundle;
  try {
    const sessionKeys = pickSessionKeyStore({ leashRoot });
    bundle = serializeLeashDir({ leashRoot, sessionKeys });
  } catch (e) {
    process.stderr.write(
      `leash export-backup: cannot read .leash/ — ${(e as Error).message}\n`,
    );
    return 1;
  }

  let password: string;
  try {
    password = await promptPassword({
      prompt: 'Password (remember: no recovery if forgotten): ',
      confirm: true,
    });
  } catch (e) {
    process.stderr.write(`leash export-backup: ${(e as Error).message}\n`);
    return 1;
  }

  const plaintext = Buffer.from(
    JSON.stringify(bundle, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    'utf8',
  );

  process.stderr.write('Deriving key (Argon2id, 64 MB, ~1s)…\n');
  let blob: Buffer;
  try {
    blob = await encryptBackup(plaintext, password);
  } catch (e) {
    process.stderr.write(
      `leash export-backup: encrypt failed — ${(e as Error).message}\n`,
    );
    return 1;
  }

  writeFileSync(outPath, blob);
  process.stdout.write(
    `  ✓ wrote ${blob.length} bytes to ${outPath}\n` +
      `    agents: ${bundle.agents.length}\n`,
  );
  return 0;
}
