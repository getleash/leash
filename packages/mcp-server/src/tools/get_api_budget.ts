import { formatUsdc } from '@getleash/core';
import type { ToolContext } from './types.js';

// ─── get_api_budget ──────────────────────────────────────────────────
//
// Returns the four spend caps + session-key expiry + live counters
// from the SQLite payment log. `accounting` is 'live' — the numbers
// are authoritative.

export interface GetApiBudgetOutput {
  session_key_expires_at: number;
  session_key_expires_at_iso: string;
  limits: {
    max_per_transaction_usdc: string;
    daily_usdc: string;
    weekly_usdc: string;
    monthly_usdc: string;
  };
  spent: {
    today_usdc: string;
    week_usdc: string;
    month_usdc: string;
  };
  remaining: {
    today_usdc: string;
    week_usdc: string;
    month_usdc: string;
  };
  /** Reliability flag — always 'live'. */
  accounting: 'live';
}

export async function handleGetApiBudget(
  ctx: ToolContext,
): Promise<GetApiBudgetOutput> {
  const grant = ctx.runtime.signedGrant.grant;
  const nowMs = Date.now();

  const spentToday = ctx.db.getSpent(grant.id, 'day', nowMs);
  const spentWeek = ctx.db.getSpent(grant.id, 'week', nowMs);
  const spentMonth = ctx.db.getSpent(grant.id, 'month', nowMs);

  return {
    session_key_expires_at: grant.validUntil,
    session_key_expires_at_iso: new Date(grant.validUntil * 1000).toISOString(),
    limits: {
      max_per_transaction_usdc: formatUsdc(grant.limits.maxPerTransaction),
      daily_usdc: formatUsdc(grant.limits.daily),
      weekly_usdc: formatUsdc(grant.limits.weekly),
      monthly_usdc: formatUsdc(grant.limits.monthly),
    },
    spent: {
      today_usdc: formatUsdc(spentToday),
      week_usdc: formatUsdc(spentWeek),
      month_usdc: formatUsdc(spentMonth),
    },
    remaining: {
      today_usdc: formatUsdc(
        clampNonNegative(grant.limits.daily - spentToday),
      ),
      week_usdc: formatUsdc(
        clampNonNegative(grant.limits.weekly - spentWeek),
      ),
      month_usdc: formatUsdc(
        clampNonNegative(grant.limits.monthly - spentMonth),
      ),
    },
    accounting: 'live',
  };
}

function clampNonNegative(v: bigint): bigint {
  return v < 0n ? 0n : v;
}
