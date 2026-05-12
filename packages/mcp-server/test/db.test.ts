import { describe, expect, it, beforeEach } from 'vitest';
import { PaymentLog, startOfWindow } from '../src/db.js';

const GRANT_A = '0199c0de-0000-7000-8000-aaaaaaaaaaaa';
const GRANT_B = '0199c0de-0000-7000-8000-bbbbbbbbbbbb';
const RECIPIENT = '0x271189c860DB25bC43173B0335784aD68a680908';

function mkLog() {
  return new PaymentLog(':memory:');
}

describe('PaymentLog insert / confirm / fail', () => {
  let log: PaymentLog;
  beforeEach(() => {
    log = mkLog();
  });

  it('inserts a pending payment and returns an id', () => {
    const id = log.insertPayment({
      grantId: GRANT_A,
      kind: 'userop',
      amount: 10_000n,
      recipient: RECIPIENT,
      status: 'pending',
    });
    expect(id).toBeGreaterThan(0);
    const row = log.getById(id)!;
    expect(row.grant_id).toBe(GRANT_A);
    expect(row.status).toBe('pending');
    expect(row.amount_base).toBe(10_000);
    expect(row.tx_hash).toBeNull();
  });

  it('confirm promotes pending → confirmed and fills tx/gas/block', () => {
    const id = log.insertPayment({
      grantId: GRANT_A,
      kind: 'userop',
      amount: 10_000n,
      recipient: RECIPIENT,
      status: 'pending',
    });
    log.confirmPayment({
      id,
      txHash: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
      blockNumber: 42n,
      gasUsed: 160_000n,
    });
    const row = log.getById(id)!;
    expect(row.status).toBe('confirmed');
    expect(row.tx_hash).toBe('0x' + 'ab'.repeat(32));
    expect(row.block_number).toBe(42);
    expect(row.gas_used).toBe(160_000);
    expect(row.confirmed_at_ms).not.toBeNull();
  });

  it('fail promotes pending → failed and records the error', () => {
    const id = log.insertPayment({
      grantId: GRANT_A,
      kind: 'userop',
      amount: 10_000n,
      recipient: RECIPIENT,
      status: 'pending',
    });
    log.failPayment({ id, error: 'AA21 didn\'t pay prefund' });
    const row = log.getById(id)!;
    expect(row.status).toBe('failed');
    expect(row.error).toContain('AA21');
  });
});

describe('PaymentLog.getSpent (windowed)', () => {
  let log: PaymentLog;
  const nowMs = Date.UTC(2026, 3, 20, 14, 5, 0); // 2026-04-20 14:05 UTC (a Monday)

  beforeEach(() => {
    log = mkLog();
  });

  it('returns 0 when no payments exist for the grant', () => {
    expect(log.getSpent(GRANT_A, 'day', nowMs)).toBe(0n);
    expect(log.getSpent(GRANT_A, 'week', nowMs)).toBe(0n);
    expect(log.getSpent(GRANT_A, 'month', nowMs)).toBe(0n);
  });

  it('sums pending + confirmed, excludes failed', () => {
    log.insertPayment({
      grantId: GRANT_A,
      kind: 'userop',
      amount: 100_000n,
      recipient: RECIPIENT,
      status: 'confirmed',
      createdAtMs: nowMs - 1000,
    });
    log.insertPayment({
      grantId: GRANT_A,
      kind: 'userop',
      amount: 50_000n,
      recipient: RECIPIENT,
      status: 'pending',
      createdAtMs: nowMs - 500,
    });
    const failedId = log.insertPayment({
      grantId: GRANT_A,
      kind: 'userop',
      amount: 999_999n,
      recipient: RECIPIENT,
      status: 'pending',
      createdAtMs: nowMs - 200,
    });
    log.failPayment({ id: failedId, error: 'nope' });
    expect(log.getSpent(GRANT_A, 'day', nowMs)).toBe(150_000n);
  });

  it('isolates by grant_id (no cross-grant bleed)', () => {
    log.insertPayment({
      grantId: GRANT_A,
      kind: 'userop',
      amount: 100_000n,
      recipient: RECIPIENT,
      status: 'confirmed',
      createdAtMs: nowMs - 500,
    });
    log.insertPayment({
      grantId: GRANT_B,
      kind: 'userop',
      amount: 500_000n,
      recipient: RECIPIENT,
      status: 'confirmed',
      createdAtMs: nowMs - 500,
    });
    expect(log.getSpent(GRANT_A, 'day', nowMs)).toBe(100_000n);
    expect(log.getSpent(GRANT_B, 'day', nowMs)).toBe(500_000n);
  });

  it('excludes payments before the window start', () => {
    const dayStart = startOfWindow('day', nowMs);
    log.insertPayment({
      grantId: GRANT_A,
      kind: 'userop',
      amount: 100_000n,
      recipient: RECIPIENT,
      status: 'confirmed',
      createdAtMs: dayStart - 1, // 1 ms before the window starts
    });
    log.insertPayment({
      grantId: GRANT_A,
      kind: 'userop',
      amount: 7n,
      recipient: RECIPIENT,
      status: 'confirmed',
      createdAtMs: dayStart,
    });
    expect(log.getSpent(GRANT_A, 'day', nowMs)).toBe(7n);
  });
});

describe('startOfWindow (UTC)', () => {
  // 2026-04-20 14:05 UTC = Monday
  const ref = Date.UTC(2026, 3, 20, 14, 5, 0);

  it('day: 2026-04-20 00:00 UTC', () => {
    expect(startOfWindow('day', ref)).toBe(Date.UTC(2026, 3, 20));
  });

  it('week: same Monday 00:00 UTC', () => {
    expect(startOfWindow('week', ref)).toBe(Date.UTC(2026, 3, 20));
  });

  it('week: for a Sunday, rolls back 6 days', () => {
    // Sunday 2026-04-19 10:00 UTC
    const sun = Date.UTC(2026, 3, 19, 10);
    // Expected Monday start = 2026-04-13.
    expect(startOfWindow('week', sun)).toBe(Date.UTC(2026, 3, 13));
  });

  it('month: 2026-04-01 00:00 UTC', () => {
    expect(startOfWindow('month', ref)).toBe(Date.UTC(2026, 3, 1));
  });
});
