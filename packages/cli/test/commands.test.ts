import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { PaymentLog } from '@getleash/mcp-server';
import { logs } from '../src/commands/logs.js';
import { status } from '../src/commands/status.js';
import { fund } from '../src/commands/fund.js';
import { drain } from '../src/commands/drain.js';
import { revoke } from '../src/commands/revoke.js';
import { captureStdio, makeLeashFixture, type LeashFixture } from './helpers.js';

describe('leash logs <agent>', () => {
  let f: LeashFixture;
  let origCwd: string;

  beforeEach(() => {
    f = makeLeashFixture();
    origCwd = process.cwd();
    process.chdir(f.root);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(f.root, { recursive: true, force: true });
  });

  it('prints "no payments yet" on an empty log', async () => {
    const { result, stdout } = await captureStdio(() => logs([f.agentName]));
    expect(result).toBe(0);
    expect(stdout).toContain('(no payments yet)');
  });

  it('renders one line per payment row, oldest first', async () => {
    const dbPath = resolve(f.leashRoot, 'agent', f.agentName, 'leash.db');
    const db = new PaymentLog(dbPath);
    db.insertPayment({
      grantId: f.grantId,
      kind: 'x402_payment',
      amount: 10_000n,
      recipient: '0x271189c860DB25bC43173B0335784aD68a680908',
      upstream: 'coinmarketcap',
      status: 'confirmed',
      createdAtMs: Date.UTC(2026, 3, 20, 14, 5, 3),
    });
    db.insertPayment({
      grantId: f.grantId,
      kind: 'userop',
      amount: 50_000n,
      recipient: '0x000000000000000000000000000000000000aaaa',
      status: 'confirmed',
      createdAtMs: Date.UTC(2026, 3, 20, 14, 5, 4),
    });
    db.close();

    const { result, stdout } = await captureStdio(() => logs([f.agentName]));
    expect(result).toBe(0);
    const lines = stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('2026-04-20 14:05:03 UTC');
    expect(lines[0]).toContain('0.01 USDC');
    expect(lines[0]).toContain('(coinmarketcap)');
    expect(lines[1]).toContain('0.05 USDC');
    expect(lines[1]).toContain('confirmed');
  });

  it('rejects missing agent name with exit 2', async () => {
    const { result, stderr } = await captureStdio(() => logs([]));
    expect(result).toBe(2);
    expect(stderr).toMatch(/missing agent name/);
  });
});

describe('leash status', () => {
  let f: LeashFixture;
  let origCwd: string;

  beforeEach(() => {
    f = makeLeashFixture();
    origCwd = process.cwd();
    process.chdir(f.root);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(f.root, { recursive: true, force: true });
  });

  it('no-argument form on an empty project tells the user to apply', async () => {
    // Nuke the fixture's .leash/agent/ to simulate "no agents yet".
    rmSync(resolve(f.leashRoot, 'agent'), { recursive: true, force: true });
    const { result, stdout } = await captureStdio(() => status([]));
    expect(result).toBe(0);
    expect(stdout).toMatch(/No agents registered/);
  });
});

describe('write commands — input validation (no RPC required)', () => {
  let f: LeashFixture;
  let origCwd: string;

  beforeEach(() => {
    f = makeLeashFixture();
    origCwd = process.cwd();
    process.chdir(f.root);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(f.root, { recursive: true, force: true });
  });

  it('fund without args returns 2 and explains usage', async () => {
    const { result, stderr } = await captureStdio(() => fund([]));
    expect(result).toBe(2);
    expect(stderr).toContain('usage: leash fund');
  });

  it('fund with invalid amount returns 2', async () => {
    const { result, stderr } = await captureStdio(() =>
      fund([f.agentName, 'abc']),
    );
    expect(result).toBe(2);
    expect(stderr).toMatch(/invalid amount/);
  });

  it('fund with zero amount returns 2', async () => {
    const { result, stderr } = await captureStdio(() =>
      fund([f.agentName, '0']),
    );
    expect(result).toBe(2);
    expect(stderr).toMatch(/amount must be > 0/);
  });

  it('drain without agent returns 2', async () => {
    const { result, stderr } = await captureStdio(() => drain([]));
    expect(result).toBe(2);
    expect(stderr).toContain('usage: leash drain');
  });

  it('revoke without agent returns 2', async () => {
    const { result, stderr } = await captureStdio(() => revoke([]));
    expect(result).toBe(2);
    expect(stderr).toContain('usage: leash revoke');
  });
});
