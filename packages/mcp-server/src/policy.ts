import type { Address } from 'viem';
import type {
  AuthorizationGrant,
  PolicyCheckResult,
} from '@getleash/core';
import { formatUsdc } from '@getleash/core';
import type { PaymentLog, SpendWindow } from './db.js';

// ─── Pre-sign policy check ───────────────────────────────────────────
//
// Runs in-process before the MCP server touches a key or submits any
// op. Returns the canonical PolicyCheckResult from @getleash/core —
// denials map 1:1 to error codes in summary/errors.md §1. If every
// gate passes, the handler proceeds to sign; the same counter
// increment then gets written after submission so a future check
// sees this payment.
//
// The post-submit accounting rule: insert with status='pending',
// flip to 'confirmed' after receipt, 'failed' on revert. Pending +
// confirmed both eat budget (DB `getSpent` sums both). Failed rows
// DO NOT count — if a UserOp reverts before any token moves, it's
// as if the spend never happened from the agent's perspective. See
// db.ts §"Spend (USDC base units) within the current calendar
// window" for the exact query.

export type PolicyTarget =
  | { kind: 'x402'; upstream: string; recipient: Address }
  | { kind: 'transfer'; recipient: Address };

export interface PolicyCheckParams {
  grant: AuthorizationGrant;
  amount: bigint; // USDC base units
  target: PolicyTarget;
  db: PaymentLog;
  /** Override Date.now() in tests / offline CLI. */
  nowMs?: number;
}

/**
 * Canonical order of checks (matching summary/errors.md precedence):
 *   1. SESSION_KEY_EXPIRED   — validity is the cheapest gate
 *   2. RECIPIENT_NOT_ALLOWLISTED — policy authorship
 *   3. OVER_PER_TX_CAP       — single-call cap
 *   4. OVER_DAILY_CAP        — windowed budgets
 *   5. OVER_WEEKLY_CAP
 *   6. OVER_MONTHLY_CAP
 *
 * INSUFFICIENT_FUNDS is NOT checked here — it's a balance-state
 * concern that the handler resolves against the public client, not
 * a grant-policy concern. Same with UPSTREAM_UNAVAILABLE and the
 * facilitator path.
 */
export function checkPolicy(params: PolicyCheckParams): PolicyCheckResult {
  const { grant, amount, target, db } = params;
  const nowMs = params.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  // 1. Session-key validity.
  if (nowSec > grant.validUntil) {
    return {
      ok: false,
      denialCode: 'SESSION_KEY_EXPIRED',
      details: {
        agent: grant.agent,
        expired_at: new Date(grant.validUntil * 1000).toISOString(),
      },
    };
  }

  // 2. Recipient allowlist.
  if (target.kind === 'x402') {
    const allowed = grant.upstreams.find((u) => u.name === target.upstream);
    if (!allowed) {
      return {
        ok: false,
        denialCode: 'RECIPIENT_NOT_ALLOWLISTED',
        details: {
          upstream: target.upstream,
          recipient: target.recipient,
          allowlisted_upstreams: grant.upstreams.map((u) => u.name),
        },
      };
    }
    // x402 recipient addresses are not pinned at apply time in MVP
    // (CMC's payTo has rotated historically). The session-key 1271
    // + on-chain SessionKeyValidator are the structural guard; the
    // grant.upstream.name is the name the human signed off on.
  } else {
    const allowed = grant.counterparties.some(
      (c) => c.address.toLowerCase() === target.recipient.toLowerCase(),
    );
    if (!allowed) {
      return {
        ok: false,
        denialCode: 'RECIPIENT_NOT_ALLOWLISTED',
        details: {
          recipient: target.recipient,
          allowlisted_counterparties: grant.counterparties.map((c) => ({
            name: c.name,
            address: c.address,
          })),
        },
      };
    }
  }

  // 3. Per-transaction cap.
  if (amount > grant.limits.maxPerTransaction) {
    return {
      ok: false,
      denialCode: 'OVER_PER_TX_CAP',
      details: {
        cap_usdc: formatUsdc(grant.limits.maxPerTransaction),
        requested_usdc: formatUsdc(amount),
      },
    };
  }

  // 4-6. Windowed spend caps.
  type WindowDenial = 'OVER_DAILY_CAP' | 'OVER_WEEKLY_CAP' | 'OVER_MONTHLY_CAP';
  const windows: Array<{ name: SpendWindow; cap: bigint; code: WindowDenial }> = [
    { name: 'day', cap: grant.limits.daily, code: 'OVER_DAILY_CAP' },
    { name: 'week', cap: grant.limits.weekly, code: 'OVER_WEEKLY_CAP' },
    { name: 'month', cap: grant.limits.monthly, code: 'OVER_MONTHLY_CAP' },
  ];

  for (const w of windows) {
    const spent = db.getSpent(grant.id, w.name, nowMs);
    if (spent + amount > w.cap) {
      return {
        ok: false,
        denialCode: w.code,
        details: {
          cap_usdc: formatUsdc(w.cap),
          spent_usdc: formatUsdc(spent),
          remaining_usdc: formatUsdc(w.cap - spent),
          requested_usdc: formatUsdc(amount),
          resets_at: new Date(windowResetsAtMs(w.name, nowMs)).toISOString(),
        },
      };
    }
  }

  return { ok: true };
}

// ─── Reset helpers (for the denial details.resets_at field) ──────────

/** When does the given window end, in unix ms? */
export function windowResetsAtMs(window: SpendWindow, nowMs: number): number {
  const d = new Date(nowMs);
  if (window === 'day') {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  }
  if (window === 'month') {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  // week: next Monday 00:00 UTC.
  const dow = d.getUTCDay();
  const daysUntilNextMon = dow === 0 ? 1 : 8 - dow;
  return (
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) +
    daysUntilNextMon * 24 * 60 * 60 * 1000
  );
}
