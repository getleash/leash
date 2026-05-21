// ─── Unimplemented stubs ─────────────────────────────────────────────
//
// Used by the dispatcher for commands whose real implementation
// lands later. Prints a tagged error to stderr and returns a
// non-zero exit code — scripts can still `grep` for the tag without
// guessing at the string.

export function make(
  command: string,
  landing: string,
): (args: string[]) => Promise<number> {
  return async (_args: string[]) => {
    process.stderr.write(
      `leash ${command}: not yet implemented on this build (landing in ${landing}).\n`,
    );
    return 2;
  };
}
