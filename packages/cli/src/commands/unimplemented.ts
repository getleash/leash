// ─── Phase-gated stubs ───────────────────────────────────────────────
//
// Used by the dispatcher for commands whose real implementation lands
// in a later sub-phase. Prints a phase-tagged error to stderr and
// returns a non-zero exit code — scripts can still `grep` for the
// phase tag without guessing at the string.

export function make(
  command: string,
  phase: string,
): (args: string[]) => Promise<number> {
  return async (_args: string[]) => {
    process.stderr.write(
      `leash ${command}: not yet implemented on this build (landing in ${phase}).\n`,
    );
    return 2;
  };
}
