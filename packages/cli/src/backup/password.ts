import { createInterface } from 'node:readline';

// ─── Interactive password prompt ─────────────────────────────────────
//
// Prompts are written to stderr (not stdout) so redirecting stdout
// doesn't swallow them or put them in a pipe where they don't belong.
// Input echoing is disabled on TTY stdin — for non-TTY (CI, headless),
// we refuse with a diagnostic rather than silently capturing an
// echoed password. `LEASH_BACKUP_PASSWORD` env var bypasses the
// prompt entirely for unattended use.
//
// `confirm: true` prompts a second time and verifies match — required
// for export (catch typos before encryption), skipped for import
// (the verify step is the decrypt attempt itself).

export interface PromptParams {
  prompt: string;
  /** Ask for the password twice and verify match. */
  confirm?: boolean;
  /** Confirmation prompt label (default: "Confirm password: "). */
  confirmPrompt?: string;
}

export async function promptPassword(params: PromptParams): Promise<string> {
  const envOverride = process.env.LEASH_BACKUP_PASSWORD;
  if (envOverride !== undefined) {
    if (envOverride.length === 0) {
      throw new Error('LEASH_BACKUP_PASSWORD is set but empty');
    }
    return envOverride;
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      'no TTY on stdin — set LEASH_BACKUP_PASSWORD to run unattended',
    );
  }

  const first = await readHidden(params.prompt);
  if (first.length === 0) {
    throw new Error('password cannot be empty');
  }
  if (!params.confirm) return first;

  const second = await readHidden(params.confirmPrompt ?? 'Confirm password: ');
  if (first !== second) {
    throw new Error("passwords don't match");
  }
  return first;
}

// ─── TTY echo suppression ────────────────────────────────────────────

async function readHidden(prompt: string): Promise<string> {
  process.stderr.write(prompt);

  // Turn off echo by putting the TTY into raw mode and reading until
  // newline. Node's readline would echo; we need byte-level control.
  const stdin = process.stdin as NodeJS.ReadStream & {
    setRawMode: (on: boolean) => NodeJS.ReadStream;
  };
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise<string>((resolve, reject) => {
    let buf = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.removeListener('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stderr.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          // Ctrl-C
          stdin.removeListener('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stderr.write('\n');
          reject(new Error('password prompt cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          // backspace
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// silence unused import warning in the types-only surface
void createInterface;
