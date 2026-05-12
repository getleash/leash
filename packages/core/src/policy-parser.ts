import type { Address } from 'viem';
import type {
  AgentPolicy,
  ChainName,
  PolicyCounterparty,
  PolicyLimits,
  PolicyUpstream,
} from './types.js';
import { parseUsdc } from './constants.js';
import { UPSTREAM_PAYTO } from './upstream-payto.js';

/**
 * Line-by-line markdown policy parser. Deliberately NOT a markdown AST
 * — user-flows.md §3 and summary/errors.md §3 promise exact line
 * numbers and canonical strings on parse failure. Keep this file
 * aligned with those goldens.
 *
 * Grammar (matches examples/cryptonit/cryptonit-policy.md):
 *
 *   # Agent Policy
 *   name:            <identifier>
 *   chain:           base | base-sepolia
 *   validity:        <N> days
 *   initial_funding: <N[.N]> USDC
 *
 *   ## Limits
 *   max_per_transaction: <amt> USDC
 *   daily_limit:         <amt> USDC
 *   weekly_limit:        <amt> USDC
 *   monthly_limit:       <amt> USDC
 *
 *   ## Upstreams
 *   - name: <ident>
 *     url:          <https URL>
 *     namespace:    <ident>
 *     max_per_call: <amt> USDC          (optional — defaults to max_per_transaction)
 *
 *   ## Recovery              (MANDATORY)
 *   drain_to_hub: enabled
 *
 *   ## Counterparties        (optional)
 *   - name: <ident>
 *     address: 0x...
 */

export class PolicyParseError extends Error {
  readonly line?: number;

  constructor(message: string, line?: number) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = 'PolicyParseError';
    this.line = line;
  }
}

/**
 * The curated allowlist — parser rejects any upstream not in this set.
 * Derived from the payTo registry so adding a new upstream is a single
 * change in `upstream-payto.ts`; the parser auto-accepts it.
 */
const SUPPORTED_UPSTREAMS = new Set<string>(Object.keys(UPSTREAM_PAYTO));

const VALID_CHAINS = new Set<ChainName>(['base', 'base-sepolia']);

const LIMIT_KEYS = new Set([
  'max_per_transaction',
  'daily_limit',
  'weekly_limit',
  'monthly_limit',
]);

type Section =
  | 'header'
  | 'limits'
  | 'upstreams'
  | 'recovery'
  | 'counterparties'
  | 'unknown';

export function parsePolicy(markdown: string): AgentPolicy {
  const lines = markdown.split('\n');

  let name: string | undefined;
  let chain: ChainName | undefined;
  let validityDays: number | undefined;
  let initialFunding: bigint | undefined;

  const limits: Partial<PolicyLimits> = {};
  const upstreams: PolicyUpstream[] = [];
  const counterparties: PolicyCounterparty[] = [];
  let drainToHub = false;

  let section: Section = 'header';
  let pendingUpstream: Partial<PolicyUpstream> | null = null;
  let pendingCounterparty: Partial<PolicyCounterparty> | null = null;

  const flushPending = (lineNum: number) => {
    if (pendingUpstream) {
      upstreams.push(finalizeUpstream(pendingUpstream, lineNum));
      pendingUpstream = null;
    }
    if (pendingCounterparty) {
      counterparties.push(finalizeCounterparty(pendingCounterparty, lineNum));
      pendingCounterparty = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const raw = lines[i];
    const line = raw.trim();

    // Blank line: inside upstreams/counterparties, a blank line closes a pending entry.
    if (line === '') {
      continue;
    }

    // `## Foo` — section header
    const sectionMatch = line.match(/^##\s+(.+?)\s*$/);
    if (sectionMatch) {
      flushPending(lineNum);
      section = normalizeSection(sectionMatch[1]);
      continue;
    }

    // Top-level `# Foo` heading or inline `# comment` — skip.
    if (line.startsWith('#')) {
      continue;
    }

    // ── Header fields ──────────────────────────────────────────────
    if (section === 'header') {
      const kv = parseKeyValue(line, lineNum);
      switch (kv.key) {
        case 'name':
          name = kv.value;
          break;
        case 'chain':
          if (!VALID_CHAINS.has(kv.value as ChainName)) {
            throw new PolicyParseError(
              `invalid chain "${kv.value}" — use "base" or "base-sepolia"`,
              lineNum,
            );
          }
          chain = kv.value as ChainName;
          break;
        case 'validity':
          validityDays = parseValidity(kv.value, lineNum);
          break;
        case 'initial_funding':
          initialFunding = parseUsdcField(kv.value, lineNum);
          break;
        default:
          throw new PolicyParseError(
            `unknown top-level field "${kv.key}"`,
            lineNum,
          );
      }
      continue;
    }

    // ── Limits ─────────────────────────────────────────────────────
    if (section === 'limits') {
      const kv = parseKeyValue(line, lineNum);
      if (!LIMIT_KEYS.has(kv.key)) {
        throw new PolicyParseError(
          `unknown limit "${kv.key}" — expected one of: ` +
            Array.from(LIMIT_KEYS).join(', '),
          lineNum,
        );
      }
      const amt = parseUsdcField(kv.value, lineNum);
      switch (kv.key) {
        case 'max_per_transaction': limits.maxPerTransaction = amt; break;
        case 'daily_limit':         limits.daily = amt;              break;
        case 'weekly_limit':        limits.weekly = amt;             break;
        case 'monthly_limit':       limits.monthly = amt;            break;
      }
      continue;
    }

    // ── Upstreams ──────────────────────────────────────────────────
    if (section === 'upstreams') {
      if (line.startsWith('- ')) {
        // Start of a new upstream entry.
        if (pendingUpstream) {
          upstreams.push(finalizeUpstream(pendingUpstream, lineNum));
          pendingUpstream = null;
        }
        const inner = line.slice(2).trim();
        const kv = parseKeyValue(inner, lineNum);
        if (kv.key !== 'name') {
          throw new PolicyParseError(
            `upstream entry must start with "- name: <identifier>"`,
            lineNum,
          );
        }
        if (!SUPPORTED_UPSTREAMS.has(kv.value)) {
          throw new PolicyParseError(
            `upstream "${kv.value}" has no Leash adapter — ` +
              `supported for MVP: ${Array.from(SUPPORTED_UPSTREAMS).join(', ')}`,
            lineNum,
          );
        }
        pendingUpstream = { name: kv.value };
        continue;
      }
      // Continuation lines: url, namespace.
      const kv = parseKeyValue(line, lineNum);
      if (!pendingUpstream) {
        throw new PolicyParseError(
          `"${kv.key}: ..." outside of an upstream entry ` +
            `(did you forget "- name: ..."?)`,
          lineNum,
        );
      }
      switch (kv.key) {
        case 'url':
          if (!kv.value.startsWith('https://')) {
            throw new PolicyParseError(
              `upstream url must be https://`,
              lineNum,
            );
          }
          pendingUpstream.url = kv.value;
          break;
        case 'namespace':
          if (!/^[a-z][a-z0-9_]*$/.test(kv.value)) {
            throw new PolicyParseError(
              `upstream namespace "${kv.value}" must match /^[a-z][a-z0-9_]*$/`,
              lineNum,
            );
          }
          pendingUpstream.namespace = kv.value;
          break;
        case 'max_per_call': {
          const amt = parseUsdcField(kv.value, lineNum);
          if (amt === 0n) {
            throw new PolicyParseError(
              `max_per_call must be > 0 (zero means "denied" on-chain — omit the field to allow up to max_per_transaction)`,
              lineNum,
            );
          }
          pendingUpstream.maxPerCall = amt;
          break;
        }
        default:
          throw new PolicyParseError(
            `unknown upstream field "${kv.key}" — expected "url", "namespace", or "max_per_call"`,
            lineNum,
          );
      }
      continue;
    }

    // ── Recovery ───────────────────────────────────────────────────
    if (section === 'recovery') {
      const kv = parseKeyValue(line, lineNum);
      if (kv.key !== 'drain_to_hub') {
        throw new PolicyParseError(
          `unknown recovery field "${kv.key}" — only "drain_to_hub" is supported`,
          lineNum,
        );
      }
      if (kv.value !== 'enabled') {
        throw new PolicyParseError(
          `drain_to_hub must be "enabled" — it is mandatory and non-negotiable`,
          lineNum,
        );
      }
      drainToHub = true;
      continue;
    }

    // ── Counterparties (optional) ──────────────────────────────────
    if (section === 'counterparties') {
      if (line.startsWith('- ')) {
        if (pendingCounterparty) {
          counterparties.push(finalizeCounterparty(pendingCounterparty, lineNum));
          pendingCounterparty = null;
        }
        const inner = line.slice(2).trim();
        const kv = parseKeyValue(inner, lineNum);
        if (kv.key !== 'name') {
          throw new PolicyParseError(
            `counterparty entry must start with "- name: <identifier>"`,
            lineNum,
          );
        }
        pendingCounterparty = { name: kv.value };
        continue;
      }
      const kv = parseKeyValue(line, lineNum);
      if (!pendingCounterparty) {
        throw new PolicyParseError(
          `"${kv.key}: ..." outside of a counterparty entry`,
          lineNum,
        );
      }
      if (kv.key !== 'address') {
        throw new PolicyParseError(
          `unknown counterparty field "${kv.key}" — expected "address"`,
          lineNum,
        );
      }
      if (!/^0x[a-fA-F0-9]{40}$/.test(kv.value)) {
        throw new PolicyParseError(
          `invalid address "${kv.value}" — expected 0x + 40 hex chars`,
          lineNum,
        );
      }
      pendingCounterparty.address = kv.value as Address;
      continue;
    }

    // Unknown section — silently ignore content (forward-compatible).
  }

  // Flush any trailing pending entry.
  flushPending(lines.length);

  // ── Required-field validation ──────────────────────────────────
  if (!name) throw new PolicyParseError('missing required field: name');
  if (!chain) throw new PolicyParseError('missing required field: chain');
  if (validityDays === undefined) {
    throw new PolicyParseError('missing required field: validity');
  }
  if (initialFunding === undefined) {
    throw new PolicyParseError('missing required field: initial_funding');
  }

  for (const k of [
    'maxPerTransaction',
    'daily',
    'weekly',
    'monthly',
  ] as const) {
    if (limits[k] === undefined) {
      const asPolicyKey =
        k === 'maxPerTransaction' ? 'max_per_transaction' : `${k}_limit`;
      throw new PolicyParseError(
        `missing required limit "${asPolicyKey}" in ## Limits`,
      );
    }
  }

  if (!drainToHub) {
    throw new PolicyParseError(
      'missing required section "## Recovery" (with drain_to_hub: enabled)',
    );
  }

  if (upstreams.length === 0) {
    throw new PolicyParseError(
      'at least one upstream required in ## Upstreams',
    );
  }

  // Limit hierarchy sanity (all fields now known).
  const L = limits as PolicyLimits;
  if (L.maxPerTransaction > L.daily) {
    throw new PolicyParseError(
      `max_per_transaction (${L.maxPerTransaction}) > daily_limit (${L.daily})`,
    );
  }
  if (L.daily > L.weekly) {
    throw new PolicyParseError(
      `daily_limit (${L.daily}) > weekly_limit (${L.weekly})`,
    );
  }
  if (L.weekly > L.monthly) {
    throw new PolicyParseError(
      `weekly_limit (${L.weekly}) > monthly_limit (${L.monthly})`,
    );
  }

  for (const u of upstreams) {
    if (u.maxPerCall !== undefined && u.maxPerCall > L.maxPerTransaction) {
      throw new PolicyParseError(
        `upstream "${u.name}" max_per_call (${u.maxPerCall}) > max_per_transaction (${L.maxPerTransaction}) — ` +
          `per-recipient caps must fit under the global per-tx cap`,
      );
    }
  }

  return {
    name,
    chain,
    validityDays,
    initialFunding,
    limits: L,
    upstreams,
    drainToHub: true,
    counterparties,
  };
}

// ─── helpers ─────────────────────────────────────────────────────────

function parseKeyValue(line: string, lineNum: number): { key: string; value: string } {
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) {
    throw new PolicyParseError(
      `expected "field: value", got "${line}"`,
      lineNum,
    );
  }
  const key = line.slice(0, colonIdx).trim().toLowerCase();
  const value = line.slice(colonIdx + 1).trim();
  if (!key) {
    throw new PolicyParseError(`empty field name`, lineNum);
  }
  return { key, value };
}

function parseValidity(value: string, lineNum: number): number {
  const m = value.match(/^(\d+)\s+days?$/);
  if (!m) {
    throw new PolicyParseError(
      `invalid validity "${value}" — use format: "30 days"`,
      lineNum,
    );
  }
  const n = parseInt(m[1], 10);
  if (n <= 0) {
    throw new PolicyParseError(`validity must be positive`, lineNum);
  }
  return n;
}

function parseUsdcField(value: string, lineNum: number): bigint {
  const m = value.match(/^(\d+(?:\.\d+)?)\s+USDC$/);
  if (!m) {
    throw new PolicyParseError(
      `invalid USDC amount "${value}" — use format: "1.00 USDC"`,
      lineNum,
    );
  }
  return parseUsdc(m[1]);
}

function normalizeSection(heading: string): Section {
  const h = heading.toLowerCase();
  if (h === 'limits') return 'limits';
  if (h === 'upstreams') return 'upstreams';
  if (h === 'recovery') return 'recovery';
  if (h.startsWith('counterparties')) return 'counterparties';
  return 'unknown';
}

function finalizeUpstream(
  p: Partial<PolicyUpstream>,
  lineNum: number,
): PolicyUpstream {
  if (!p.name || !p.url || !p.namespace) {
    const missing: string[] = [];
    if (!p.url) missing.push('url');
    if (!p.namespace) missing.push('namespace');
    throw new PolicyParseError(
      `upstream "${p.name ?? '?'}" missing fields: ${missing.join(', ')}`,
      lineNum,
    );
  }
  return p as PolicyUpstream;
}

function finalizeCounterparty(
  p: Partial<PolicyCounterparty>,
  lineNum: number,
): PolicyCounterparty {
  if (!p.name || !p.address) {
    throw new PolicyParseError(
      `counterparty "${p.name ?? '?'}" missing "address"`,
      lineNum,
    );
  }
  return p as PolicyCounterparty;
}
