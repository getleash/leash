// Shared context for the walking-skeleton demo. Everything stateful
// (ledger, signer, bundler, keychain, SQLite handle, clock, random
// generator, cwd) lives on this object so the orchestrator can hand the
// same instance to every CLI command and make the run reproducible.

import Database from "better-sqlite3";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// -------- Frozen clock --------

export class Clock {
  private t: Date;
  constructor(iso: string) {
    this.t = new Date(iso);
  }
  set(iso: string) {
    this.t = new Date(iso);
  }
  advance(seconds: number) {
    this.t = new Date(this.t.getTime() + seconds * 1000);
  }
  nowIso(): string {
    return this.t.toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  // "17:22:00 UTC"
  nowUtcShort(): string {
    return `${pad2(this.t.getUTCHours())}:${pad2(this.t.getUTCMinutes())} UTC`;
  }
  // "17:24:18"
  nowUtcHMS(): string {
    return `${pad2(this.t.getUTCHours())}:${pad2(this.t.getUTCMinutes())}:${pad2(this.t.getUTCSeconds())}`;
  }
  // "2026-05-14 17:22 UTC"
  plusDaysShort(days: number): string {
    const d = new Date(this.t.getTime() + days * 86400 * 1000);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
  }
  plusDaysIso(days: number): string {
    const d = new Date(this.t.getTime() + days * 86400 * 1000);
    return d.toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  // "2026-05-14"
  plusDaysDate(days: number): string {
    const d = new Date(this.t.getTime() + days * 86400 * 1000);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  }
}

function pad2(n: number) {
  return n.toString().padStart(2, "0");
}

// -------- Stub keychain --------

export class Keychain {
  private store = new Map<string, string>();
  set(service: string, value: string) {
    this.store.set(service, value);
  }
  get(service: string): string | undefined {
    return this.store.get(service);
  }
  has(service: string): boolean {
    return this.store.has(service);
  }
  delete(service: string) {
    this.store.delete(service);
  }
}

// -------- Stub USDC ledger --------

// "Balance" is bigint base units (6 decimals for USDC).
export class Ledger {
  private balances = new Map<string, bigint>();

  balance(addr: string): bigint {
    return this.balances.get(addr) ?? 0n;
  }
  mint(addr: string, amount: bigint) {
    this.balances.set(addr, this.balance(addr) + amount);
  }
  transfer(from: string, to: string, amount: bigint) {
    const bal = this.balance(from);
    if (bal < amount) {
      throw new Error(`ledger: insufficient funds at ${from}: ${bal} < ${amount}`);
    }
    this.balances.set(from, bal - amount);
    this.balances.set(to, this.balance(to) + amount);
  }
}

// -------- Stub signer --------

// Issues deterministic "signatures" that the skeleton treats as opaque.
export class Signer {
  sign(data: string): string {
    return `sig(${data.slice(0, 16)}…)`;
  }
}

// -------- Stub bundler --------

export interface UserOp {
  sender: string;
  target: string;
  selector: string; // e.g. "removeSessionKey", "transfer"
  value: bigint;
  data: unknown;
}

export interface BundlerResult {
  userOpHash: string;
  txHash: string;
  block: number;
  ok: boolean;
}

export class Bundler {
  private ctx: Context;
  private blockCounter = 18223200;
  constructor(ctx: Context) {
    this.ctx = ctx;
  }
  submit(op: UserOp, txTag: string): BundlerResult {
    const userOpHash = `0x${txTag.replace("0x", "").replace("…", "")}uop…`.replace(/^0xuop/, "0xuop");
    // Apply the effect if it's a USDC transfer UserOp.
    if (op.selector === "transfer") {
      const [to, amount] = op.data as [string, bigint];
      this.ctx.ledger.transfer(op.sender, to, amount);
    }
    this.blockCounter += Math.floor(Math.random() * 0) + 1; // deterministic +1 each
    return { userOpHash: "0xuop…", txHash: txTag, block: this.blockCounter - 1 + 1, ok: true };
  }
  // Submit a revoke UserOp. Returns the revoke block + tx.
  revokeSessionKey(sender: string): BundlerResult {
    // User-flows fixture pins block to 18223222 and tx to 0xrev…
    return { userOpHash: "0xuop…", txHash: "0xrev…", block: 18223222, ok: true };
  }
  // Fund the sub-account from the hub (just a ledger transfer pretending to be a UserOp).
  fundSub(hub: string, sub: string, amount: bigint, txTag: string): BundlerResult {
    this.ctx.ledger.transfer(hub, sub, amount);
    return { userOpHash: "0xuop…", txHash: txTag, block: 18223210, ok: true };
  }
}

// -------- Writer (stdout capture) --------

export class Writer {
  private buf: string[] = [];
  print(s: string) {
    this.buf.push(s);
  }
  println(s = "") {
    this.buf.push(s + "\n");
  }
  reset() {
    this.buf = [];
  }
  capture(): string {
    return this.buf.join("");
  }
}

// -------- Context --------

export interface Context {
  cwd: string;
  clock: Clock;
  keychain: Keychain;
  ledger: Ledger;
  signer: Signer;
  bundler: Bundler;
  db: Database.Database;
  writer: Writer;
  // Fixed identifiers the fixtures pin:
  hubAddr: string;
  hubAddrShort: string;
  subAddr: string;
  subAddrShort: string;
  sessionKeyAddr: string;
  sessionKeyAddrShort: string;
  cmcRecipient: string;
  // Whether we've "revoked" the session key in-process.
  revoked: boolean;
  revokedAtBlock?: number;
  revokedAtTx?: string;
}

export function newContext(tmpDir: string, isoNow: string): Context {
  mkdirSync(tmpDir, { recursive: true });
  const dbPath = join(tmpDir, ".leash", "leash.db");
  mkdirSync(join(tmpDir, ".leash"), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at_iso TEXT NOT NULL,
      tool TEXT NOT NULL,
      args_json TEXT NOT NULL,
      amount_base BIGINT NOT NULL,
      recipient TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      facilitator TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS counters (
      window TEXT PRIMARY KEY,          -- "daily" | "weekly" | "monthly"
      spent_base BIGINT NOT NULL DEFAULT 0,
      resets_at_iso TEXT NOT NULL
    );
  `);
  const ctx: Context = {
    cwd: tmpDir,
    clock: new Clock(isoNow),
    keychain: new Keychain(),
    ledger: new Ledger(),
    signer: new Signer(),
    bundler: null as any, // set below
    db,
    writer: new Writer(),
    hubAddr: "0xHub11111111111111111111111111111111111111",
    hubAddrShort: "0xHub1111…",
    subAddr: "0xSub22222222222222222222222222222222222222",
    subAddrShort: "0xSub2222…",
    sessionKeyAddr: "0xSessKey44444444444444444444444444444444",
    sessionKeyAddrShort: "0xSessKey4444…",
    cmcRecipient: "0x271189c860Db25bC43173B0335784aD68a680908",
    revoked: false,
  };
  ctx.bundler = new Bundler(ctx);
  return ctx;
}

export function disposeContext(ctx: Context, opts: { keep?: boolean } = {}) {
  ctx.db.close();
  if (!opts.keep) rmSync(ctx.cwd, { recursive: true, force: true });
}

// -------- Helpers for fixture-consistent rendering --------

// "0xHub1111…" — abbreviated form used in transcripts.
export function shortAddr(addr: string): string {
  // Keep the first 8 chars after 0x, plus "…"
  if (addr.startsWith("0x")) return addr.slice(0, 10) + "…";
  return addr.slice(0, 8) + "…";
}

// "0x271189…0908" — head+tail form used for recipients in log lines.
export function headTailAddr(addr: string): string {
  return addr.slice(0, 8) + "…" + addr.slice(-4);
}

export function formatUsdc(base: bigint): string {
  const whole = base / 1_000_000n;
  const frac = (base % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return `${whole}.${frac}`;
}

export function parseUsdc(human: string): bigint {
  // "1.00 USDC" or "0.01"
  const m = human.replace(/USDC/gi, "").trim().match(/^(\d+)\.(\d+)$/);
  if (!m) throw new Error(`bad USDC amount: ${human}`);
  const [, whole, frac] = m;
  const fracPadded = (frac + "000000").slice(0, 6);
  return BigInt(whole) * 1_000_000n + BigInt(fracPadded);
}
