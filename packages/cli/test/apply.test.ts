import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { apply } from '../src/commands/apply.js';
import { captureStdio } from './helpers.js';

const MIN_POLICY = `# Agent Policy
name: cryptonit
chain: base
validity: 30 days
initial_funding: 1.00 USDC

## Limits
max_per_transaction: 0.10 USDC
daily_limit:         1.00 USDC
weekly_limit:        5.00 USDC
monthly_limit:      15.00 USDC

## Upstreams
- name: coinmarketcap
  url: https://mcp.coinmarketcap.com/x402/mcp
  namespace: coinmarketcap

## Recovery
drain_to_hub: enabled
`;

describe('leash apply — input + early exits', () => {
  let dir: string;
  let origCwd: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'leash-apply-'));
    origCwd = process.cwd();
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('missing policy path → exit 2 + usage to stderr', async () => {
    const { result, stderr } = await captureStdio(() => apply([]));
    expect(result).toBe(2);
    expect(stderr).toContain('missing policy path');
  });

  it('policy file not found → exit 2', async () => {
    const { result, stderr } = await captureStdio(() =>
      apply([resolve(dir, 'nope.md')]),
    );
    expect(result).toBe(2);
    expect(stderr).toMatch(/cannot read/);
  });

  it('parse error surfaces with the policy path', async () => {
    const path = resolve(dir, 'bad-policy.md');
    writeFileSync(path, '# not a valid policy\n');
    const { result, stderr } = await captureStdio(() => apply([path]));
    expect(result).toBe(2);
    expect(stderr).toContain('Parse error in');
    expect(stderr).toContain('bad-policy.md');
  });

  // The "LeashFactory not yet deployed on <chain>" early-exit guard
  // (apply.ts ~line 114) used to be exercised here against both
  // BASE_MAINNET and BASE_SEPOLIA. Once Phase 8 contracts land in
  // constants.ts for either chain, that path becomes unreachable
  // through the real chain config — the guard still runs in
  // production against half-edited constants.ts, but there's no
  // chain identifier left in unit-test-land where it stays ZERO.
  // Coherence of constants.ts is enforced by
  // assertPhase8Coherent() in core/constants.test.ts (rejects
  // partial deploys); the runtime guard in apply.ts is trivial
  // enough that mocking the chain config to keep this test alive
  // is more cost than it pays back.
});
