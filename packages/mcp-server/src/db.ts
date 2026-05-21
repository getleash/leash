import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Address, Hex } from 'viem';

// ─── Schema ──────────────────────────────────────────────────────────
//
// One table — `payments` — covers both x402 settlements and UserOp
// actions. `grant_id` ties every row back to the AuthorizationGrant
// that authorized it. Amounts are stored as INTEGER (SQLite signed
// 64-bit fits USDC base units up to ~9.2e18, way past any realistic
// cap). Timestamps are unix milliseconds.
//
// Consumers: policy.ts (aggregate spend-so-far per window) and
// get_api_budget (remaining = cap − spent).

const SCHEMA = `
CREATE TABLE IF NOT EXISTS payments (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id              TEXT    NOT NULL,
  kind                  TEXT    NOT NULL CHECK(kind IN ('x402_payment','userop')),
  amount_base           INTEGER NOT NULL,
  recipient             TEXT    NOT NULL,
  upstream              TEXT,
  authorization_digest  TEXT,
  user_op_hash          TEXT,
  tx_hash               TEXT,
  status                TEXT    NOT NULL CHECK(status IN ('pending','confirmed','failed')),
  block_number          INTEGER,
  gas_used              INTEGER,
  error                 TEXT,
  created_at_ms         INTEGER NOT NULL,
  confirmed_at_ms       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_payments_grant_created
  ON payments(grant_id, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_payments_status
  ON payments(status);

CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER NOT NULL
);
`;

const SCHEMA_VERSION = 1;

// ─── Types ───────────────────────────────────────────────────────────

export type PaymentKind = 'x402_payment' | 'userop';
export type PaymentStatus = 'pending' | 'confirmed' | 'failed';

export interface InsertPaymentParams {
  grantId: string;
  kind: PaymentKind;
  /** USDC base units (bigint → stored as INTEGER). */
  amount: bigint;
  recipient: Address;
  /** Upstream name for x402; null for UserOp transfers. */
  upstream?: string;
  authorizationDigest?: Hex;
  userOpHash?: Hex;
  status: PaymentStatus;
  createdAtMs?: number; // defaults to Date.now()
}

export interface ConfirmPaymentParams {
  id: number;
  txHash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
}

export interface FailPaymentParams {
  id: number;
  error: string;
}

export interface PaymentRow {
  id: number;
  grant_id: string;
  kind: PaymentKind;
  amount_base: number; // SQLite returns INTEGER as number (safe up to 2^53).
  recipient: Address;
  upstream: string | null;
  authorization_digest: Hex | null;
  user_op_hash: Hex | null;
  tx_hash: Hex | null;
  status: PaymentStatus;
  block_number: number | null;
  gas_used: number | null;
  error: string | null;
  created_at_ms: number;
  confirmed_at_ms: number | null;
}

export type SpendWindow = 'day' | 'week' | 'month';

// ─── Store ───────────────────────────────────────────────────────────

export class PaymentLog {
  readonly path: string;
  private readonly db: Database.Database;

  /**
   * Open or create the SQLite database at the given path. `:memory:`
   * is supported for tests. Parent directories are created if needed.
   */
  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') {
      const dir = dirname(resolve(path));
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.ensureSchemaVersion();
  }

  private ensureSchemaVersion() {
    const row = this.db.prepare('SELECT version FROM schema_meta').get() as
      | { version: number }
      | undefined;
    if (!row) {
      this.db.prepare('INSERT INTO schema_meta (version) VALUES (?)').run(SCHEMA_VERSION);
    } else if (row.version !== SCHEMA_VERSION) {
      throw new Error(
        `PaymentLog: schema version mismatch (db=${row.version}, code=${SCHEMA_VERSION}). ` +
          `Migration not yet implemented — drop the file or implement a migration step.`,
      );
    }
  }

  // ─── Writes ────────────────────────────────────────────────────────

  insertPayment(params: InsertPaymentParams): number {
    const createdAtMs = params.createdAtMs ?? Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO payments
           (grant_id, kind, amount_base, recipient, upstream,
            authorization_digest, user_op_hash, status, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.grantId,
        params.kind,
        params.amount.toString(), // better-sqlite3 accepts string for INTEGER
        params.recipient,
        params.upstream ?? null,
        params.authorizationDigest ?? null,
        params.userOpHash ?? null,
        params.status,
        createdAtMs,
      );
    return Number(info.lastInsertRowid);
  }

  confirmPayment(params: ConfirmPaymentParams): void {
    this.db
      .prepare(
        `UPDATE payments
         SET status = 'confirmed',
             tx_hash = ?,
             block_number = ?,
             gas_used = ?,
             confirmed_at_ms = ?
         WHERE id = ?`,
      )
      .run(
        params.txHash,
        Number(params.blockNumber),
        Number(params.gasUsed),
        Date.now(),
        params.id,
      );
  }

  failPayment(params: FailPaymentParams): void {
    this.db
      .prepare(`UPDATE payments SET status = 'failed', error = ? WHERE id = ?`)
      .run(params.error, params.id);
  }

  // ─── Reads ─────────────────────────────────────────────────────────

  /**
   * Spend (USDC base units) within the current calendar window (UTC)
   * for a given grant. Counts `pending` + `confirmed` — a pending
   * payment still eats the budget until it fails. Per the
   * asymmetric-enforcement policy in architecture.md §"Policy
   * enforcement surfaces", this is the sole authority for caps over
   * the per-tx limit.
   */
  getSpent(grantId: string, window: SpendWindow, nowMs: number = Date.now()): bigint {
    const windowStartMs = startOfWindow(window, nowMs);
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_base), 0) AS total
         FROM payments
         WHERE grant_id = ?
           AND status IN ('pending','confirmed')
           AND created_at_ms >= ?`,
      )
      .get(grantId, windowStartMs) as { total: number | string | null };
    return BigInt(row.total ?? 0);
  }

  listRecent(grantId: string, limit = 50): PaymentRow[] {
    return this.db
      .prepare(
        `SELECT * FROM payments
         WHERE grant_id = ?
         ORDER BY created_at_ms DESC
         LIMIT ?`,
      )
      .all(grantId, limit) as PaymentRow[];
  }

  getById(id: number): PaymentRow | undefined {
    return this.db
      .prepare('SELECT * FROM payments WHERE id = ?')
      .get(id) as PaymentRow | undefined;
  }

  close(): void {
    this.db.close();
  }
}

// ─── Window helpers ──────────────────────────────────────────────────

/**
 * Start-of-window in unix milliseconds, UTC. `day` is the current
 * UTC day's 00:00; `week` is Monday 00:00 UTC (ISO 8601 week); `month`
 * is the 1st at 00:00 UTC.
 *
 * Exposed for testing — production callers go through getSpent.
 */
export function startOfWindow(window: SpendWindow, nowMs: number): number {
  const d = new Date(nowMs);
  if (window === 'day') {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  if (window === 'month') {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  // week: ISO Monday 00:00 UTC.
  // getUTCDay returns 0 (Sun) … 6 (Sat); ISO week starts Mon (1).
  const dow = d.getUTCDay();
  const daysSinceMon = dow === 0 ? 6 : dow - 1;
  return (
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
    daysSinceMon * 24 * 60 * 60 * 1000
  );
}
