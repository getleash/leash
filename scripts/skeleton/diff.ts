// Line-level diff against a fixture file. Byte-exact comparison would be
// too fragile for the skeleton (stray-whitespace flakiness outweighs
// safety). We trim trailing whitespace on each line but require the
// content and line count to match exactly.

import { readFileSync } from "node:fs";

export interface DiffResult {
  ok: boolean;
  message: string;
}

export function diffAgainstFixture(
  label: string,
  actual: string,
  fixturePath: string,
): DiffResult {
  const expected = readFileSync(fixturePath, "utf8");
  const aLines = actual.replace(/\n+$/, "\n").split("\n");
  const eLines = expected.replace(/\n+$/, "\n").split("\n");
  const max = Math.max(aLines.length, eLines.length);
  const diffs: string[] = [];
  for (let i = 0; i < max; i++) {
    const a = (aLines[i] ?? "").replace(/[ \t]+$/, "");
    const e = (eLines[i] ?? "").replace(/[ \t]+$/, "");
    if (a !== e) {
      diffs.push(`  line ${i + 1}:`);
      diffs.push(`    expected: ${JSON.stringify(e)}`);
      diffs.push(`    actual:   ${JSON.stringify(a)}`);
    }
  }
  if (diffs.length === 0) {
    return { ok: true, message: `✓ ${label} matches ${fixturePath}` };
  }
  return {
    ok: false,
    message: [`✗ ${label} drift vs ${fixturePath}`, ...diffs].join("\n"),
  };
}

export function diffJson(
  label: string,
  actual: unknown,
  fixturePath: string,
): DiffResult {
  const expectedRaw = readFileSync(fixturePath, "utf8");
  const expected = JSON.parse(expectedRaw);
  const a = normalize(actual);
  const e = normalize(expected);
  if (a === e) {
    return { ok: true, message: `✓ ${label} matches ${fixturePath}` };
  }
  return {
    ok: false,
    message:
      `✗ ${label} drift vs ${fixturePath}\n` +
      `    expected: ${e}\n` +
      `    actual:   ${a}`,
  };
}

function normalize(v: unknown): string {
  // Canonical JSON with sorted keys.
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}
