import { beforeEach, describe, expect, it } from 'vitest';
import type { AuthorizationGrant } from '@getleash/core';
import { PaymentLog } from '../src/db.js';
import { checkPolicy, windowResetsAtMs } from '../src/policy.js';

const NOW_MS = Date.UTC(2026, 3, 20, 14, 5); // Monday 2026-04-20 14:05 UTC
const NOW_SEC = Math.floor(NOW_MS / 1000);

function grant(overrides: Partial<AuthorizationGrant> = {}): AuthorizationGrant {
  return {
    id: 'grant-1',
    principal: '0x0000000000000000000000000000000000000001',
    agent: '0x0000000000000000000000000000000000000002',
    subAccount: '0x0000000000000000000000000000000000000003',
    chain: 'base',
    validFrom: NOW_SEC - 86_400,
    validUntil: NOW_SEC + 86_400,
    purpose: 'test',
    limits: {
      maxPerTransaction: 100_000n,     // 0.10 USDC
      daily: 1_000_000n,               // 1.00 USDC
      weekly: 5_000_000n,              // 5.00 USDC
      monthly: 15_000_000n,            // 15.00 USDC
    },
    upstreams: [
      {
        name: 'coinmarketcap',
        url: 'https://mcp.coinmarketcap.com/x402/mcp',
        namespace: 'coinmarketcap',
      },
    ],
    counterparties: [
      {
        name: 'monthly-invoice',
        address: '0x000000000000000000000000000000000000aaaa',
      },
    ],
    policyHash: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
    ...overrides,
  };
}

describe('checkPolicy (happy path)', () => {
  let db: PaymentLog;
  beforeEach(() => {
    db = new PaymentLog(':memory:');
  });

  it('x402 to an allowlisted upstream under caps = ok', () => {
    const r = checkPolicy({
      grant: grant(),
      amount: 10_000n,
      target: {
        kind: 'x402',
        upstream: 'coinmarketcap',
        recipient: '0x271189c860DB25bC43173B0335784aD68a680908',
      },
      db,
      nowMs: NOW_MS,
    });
    expect(r.ok).toBe(true);
  });

  it('transfer to a listed counterparty under caps = ok', () => {
    const r = checkPolicy({
      grant: grant(),
      amount: 10_000n,
      target: {
        kind: 'transfer',
        recipient: '0x000000000000000000000000000000000000AaAa',
      },
      db,
      nowMs: NOW_MS,
    });
    expect(r.ok).toBe(true);
  });
});

describe('checkPolicy denials', () => {
  let db: PaymentLog;
  beforeEach(() => {
    db = new PaymentLog(':memory:');
  });

  it('SESSION_KEY_EXPIRED when nowSec > validUntil', () => {
    const r = checkPolicy({
      grant: grant({ validUntil: NOW_SEC - 1 }),
      amount: 1_000n,
      target: {
        kind: 'x402',
        upstream: 'coinmarketcap',
        recipient: '0x271189c860DB25bC43173B0335784aD68a680908',
      },
      db,
      nowMs: NOW_MS,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.denialCode).toBe('SESSION_KEY_EXPIRED');
      expect(r.details).toMatchObject({ agent: grant().agent });
    }
  });

  it('RECIPIENT_NOT_ALLOWLISTED when x402 upstream is unknown', () => {
    const r = checkPolicy({
      grant: grant(),
      amount: 1_000n,
      target: {
        kind: 'x402',
        upstream: 'opensea',
        recipient: '0x271189c860DB25bC43173B0335784aD68a680908',
      },
      db,
      nowMs: NOW_MS,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.denialCode).toBe('RECIPIENT_NOT_ALLOWLISTED');
  });

  it('RECIPIENT_NOT_ALLOWLISTED when transfer recipient is not on the counterparty list', () => {
    const r = checkPolicy({
      grant: grant(),
      amount: 1_000n,
      target: {
        kind: 'transfer',
        recipient: '0x0000000000000000000000000000000000000999',
      },
      db,
      nowMs: NOW_MS,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.denialCode).toBe('RECIPIENT_NOT_ALLOWLISTED');
  });

  it('OVER_PER_TX_CAP when amount exceeds the per-tx cap', () => {
    const r = checkPolicy({
      grant: grant(),
      amount: 200_000n,
      target: {
        kind: 'x402',
        upstream: 'coinmarketcap',
        recipient: '0x271189c860DB25bC43173B0335784aD68a680908',
      },
      db,
      nowMs: NOW_MS,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.denialCode).toBe('OVER_PER_TX_CAP');
      expect(r.details).toMatchObject({
        cap_usdc: '0.1',
        requested_usdc: '0.2',
      });
    }
  });

  it('OVER_DAILY_CAP when today + amount exceeds daily', () => {
    const g = grant();
    // Fill today's window to 0.95 USDC so a 0.10 call crosses the daily cap (1.00).
    db.insertPayment({
      grantId: g.id,
      kind: 'userop',
      amount: 950_000n,
      recipient: '0x0000000000000000000000000000000000000aaa',
      status: 'confirmed',
      createdAtMs: NOW_MS - 1000,
    });
    const r = checkPolicy({
      grant: g,
      amount: 100_000n,
      target: {
        kind: 'x402',
        upstream: 'coinmarketcap',
        recipient: '0x271189c860DB25bC43173B0335784aD68a680908',
      },
      db,
      nowMs: NOW_MS,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.denialCode).toBe('OVER_DAILY_CAP');
      expect(r.details).toMatchObject({
        cap_usdc: '1.0',
        spent_usdc: '0.95',
        requested_usdc: '0.1',
      });
      // resets_at must be present + look like an ISO timestamp
      expect(String(r.details.resets_at)).toMatch(
        /^\d{4}-\d{2}-\d{2}T/,
      );
    }
  });

  it('OVER_WEEKLY_CAP when week + amount exceeds weekly but day fits', () => {
    // Thursday 2026-04-23 14:05 UTC — gives us earlier-in-week days
    // (Mon/Tue/Wed) within the week window.
    const thursday = Date.UTC(2026, 3, 23, 14, 5);
    // Extend validity past thursday so SESSION_KEY_EXPIRED doesn't fire first.
    const g = grant({ validUntil: Math.floor(thursday / 1000) + 86_400 });
    // 4.95 USDC spent on Tuesday → inside the Mon-start week window,
    // but outside today (Thursday) so OVER_DAILY does not fire first.
    db.insertPayment({
      grantId: g.id,
      kind: 'userop',
      amount: 4_950_000n,
      recipient: '0x0000000000000000000000000000000000000aaa',
      status: 'confirmed',
      createdAtMs: Date.UTC(2026, 3, 21, 10, 0),
    });
    const r = checkPolicy({
      grant: g,
      amount: 100_000n,
      target: {
        kind: 'x402',
        upstream: 'coinmarketcap',
        recipient: '0x271189c860DB25bC43173B0335784aD68a680908',
      },
      db,
      nowMs: thursday,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.denialCode).toBe('OVER_WEEKLY_CAP');
  });
});

describe('windowResetsAtMs', () => {
  const ref = Date.UTC(2026, 3, 20, 14, 5); // Monday 2026-04-20 14:05 UTC

  it('day resets at next 00:00 UTC', () => {
    expect(windowResetsAtMs('day', ref)).toBe(Date.UTC(2026, 3, 21));
  });

  it('week resets at next Monday 00:00 UTC', () => {
    expect(windowResetsAtMs('week', ref)).toBe(Date.UTC(2026, 3, 27));
  });

  it('month resets at the 1st of next month 00:00 UTC', () => {
    expect(windowResetsAtMs('month', ref)).toBe(Date.UTC(2026, 4, 1));
  });
});
