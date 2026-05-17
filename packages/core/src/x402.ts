import type {
  X402Accepted,
  X402Authorization,
  X402Challenge,
  X402LeashMeta,
  X402Network,
  X402PaymentPayload,
  X402PaymentPayloadV1,
  X402PaymentPayloadV2,
} from './types.js';
import type { Hex } from 'viem';

// ─── x402 response parser ────────────────────────────────────────────
//
// Normalizes v1 vs v2 and body-vs-header delivery into a single
// X402Challenge shape. Fixtures in x402.test.ts come from
// poc/b-x402-proxy/findings.md — the flagship upstream (CMC) ships v2
// with the challenge in the `Payment-Required` HTTP header, not the
// body. Clients that only look at the body will not work with CMC.

export interface ParseX402Input {
  /** Response headers. Name matching is case-insensitive. */
  headers: Record<string, string> | Headers;
  /** Raw response body (text, UTF-8). Empty string if absent. */
  body: string;
}

export class X402ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'X402ParseError';
  }
}

/**
 * Parse an HTTP 402 response into a normalized challenge. Tries the
 * `Payment-Required` header first (v2, CMC-style), then falls back to
 * the body (v1 or body-delivered v2).
 */
export function parseX402Challenge(input: ParseX402Input): X402Challenge {
  const headerValue = findHeader(input.headers, 'Payment-Required');
  if (headerValue) {
    const decoded = base64UrlDecodeToString(headerValue);
    const json = safeParseJson(decoded, 'Payment-Required header');
    return normalize(json, 'header');
  }

  if (input.body && input.body.trim()) {
    const json = safeParseJson(input.body, '402 response body');
    return normalize(json, 'body');
  }

  throw new X402ParseError(
    'no x402 challenge found: no Payment-Required header and empty body',
  );
}

function normalize(raw: unknown, source: 'header' | 'body'): X402Challenge {
  if (!isRecord(raw)) {
    throw new X402ParseError('x402 challenge must be a JSON object');
  }

  const version = raw.x402Version;
  if (version !== 1 && version !== 2) {
    throw new X402ParseError(
      `unsupported x402Version: ${JSON.stringify(version)} (want 1 or 2)`,
    );
  }

  const accepts = raw.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) {
    throw new X402ParseError('x402 challenge missing accepts[]');
  }

  // Multi-chain upstreams (invy, azursafe, ottoai, …) publish accepts[]
  // arrays containing entries for several chains — eg. [eip155:8453,
  // eip155:1, solana:…]. Each entry is a valid alternative payment path
  // for a client on the corresponding chain. We're on Base; entries on
  // chains/schemes we don't handle are not errors, just alternatives we
  // won't take. Pre-filter by network + scheme strings only — anything
  // that passes that prefilter goes through `normalizeAccepted` and any
  // structural error (bad payTo, missing asset, etc.) still bubbles up.
  const supportedAccepts = accepts.filter(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) &&
      entry.scheme === 'exact' &&
      isSupportedNetworkString(entry.network),
  );

  if (supportedAccepts.length === 0) {
    throw new X402ParseError(
      'no usable accepts[] entry — challenge requires a chain/scheme Leash does not support',
    );
  }

  const normalizedAccepts = supportedAccepts.map(normalizeAccepted);
  const resource = isRecord(raw.resource)
    ? ({
        url: String(raw.resource.url ?? ''),
        description:
          typeof raw.resource.description === 'string'
            ? raw.resource.description
            : undefined,
      } as X402Challenge['resource'])
    : undefined;

  return {
    x402Version: version,
    error: typeof raw.error === 'string' ? raw.error : 'Payment required',
    resource,
    accepts: normalizedAccepts,
    source,
    retryHeader: version === 2 ? 'Payment-Signature' : 'X-PAYMENT',
  };
}

function normalizeAccepted(raw: unknown): X402Accepted {
  if (!isRecord(raw)) {
    throw new X402ParseError('accepts[] entry must be an object');
  }
  if (raw.scheme !== 'exact') {
    throw new X402ParseError(
      `unsupported scheme "${String(raw.scheme)}" (only "exact" is supported)`,
    );
  }
  const network = normalizeNetwork(raw.network);
  return {
    scheme: 'exact',
    network,
    asset: require0x(raw.asset, 'asset'),
    // Per PoC-B: amount is a decimal string (NOT bigint / hex). Keep it.
    amount: String(raw.amount ?? raw.maxAmountRequired ?? '0'),
    payTo: require0x(raw.payTo, 'payTo'),
    maxTimeoutSeconds:
      typeof raw.maxTimeoutSeconds === 'number' ? raw.maxTimeoutSeconds : 30,
    extra: isRecord(raw.extra) ? (raw.extra as X402Accepted['extra']) : undefined,
  };
}

function normalizeNetwork(raw: unknown): X402Network {
  const n = String(raw);
  switch (n) {
    case 'base':
    case 'base-sepolia':
    case 'eip155:8453':
    case 'eip155:84532':
      return n;
    default:
      throw new X402ParseError(`unsupported network "${n}"`);
  }
}

/**
 * Cheap string-only check used by the accepts[] prefilter to drop
 * other-chain entries before we attempt full structural validation.
 * Keep in sync with `normalizeNetwork`.
 */
function isSupportedNetworkString(raw: unknown): boolean {
  const n = String(raw);
  return (
    n === 'base' ||
    n === 'base-sepolia' ||
    n === 'eip155:8453' ||
    n === 'eip155:84532'
  );
}

/** Convert an X402 network string (CAIP-2 or shorthand) to an EVM chain id. */
export function networkToChainId(network: X402Network): number {
  switch (network) {
    case 'base':
    case 'eip155:8453':
      return 8453;
    case 'base-sepolia':
    case 'eip155:84532':
      return 84532;
  }
}

// ─── x402 retry payload builder ──────────────────────────────────────
//
// v1 and v2 diverge on shape: v1 hoists scheme/network to the top; v2
// nests them inside `accepted` and echoes the challenge's `resource`.
// See poc/b-x402-proxy/findings.md §"Payment-Signature v2 payload shape".

export interface BuildPaymentPayloadParams {
  challenge: X402Challenge;
  /** The `accepts[]` entry the client chose — must be one from the challenge. */
  chosen: X402Accepted;
  signature: Hex;
  authorization: X402Authorization;
  /**
   * Optional Leash metadata to embed under `payload.meta.leash`.
   * Facilitators pass it through; counterparties that want to verify
   * the authorization chain can consume it. See
   * summary/authorization-object.md §"Reference".
   */
  leashMeta?: X402LeashMeta;
}

export function buildPaymentPayload({
  challenge,
  chosen,
  signature,
  authorization,
  leashMeta,
}: BuildPaymentPayloadParams): X402PaymentPayload {
  if (!challenge.accepts.some((a) => sameAccepted(a, chosen))) {
    throw new X402ParseError('chosen accepted terms not found in challenge');
  }
  const meta = leashMeta ? { leash: leashMeta } : undefined;

  if (challenge.x402Version === 1) {
    const payload: X402PaymentPayloadV1 = {
      x402Version: 1,
      scheme: chosen.scheme,
      network: chosen.network,
      payload: { signature, authorization },
      ...(meta ? { meta } : {}),
    };
    return payload;
  }

  // `resource` is echoed back when the challenge carries it. Some
  // upstreams (invy) publish v2 challenges without a `resource` field;
  // the spec text reads "echo if present" so we omit instead of throwing.
  const payload: X402PaymentPayloadV2 = {
    x402Version: 2,
    ...(challenge.resource ? { resource: challenge.resource } : {}),
    accepted: chosen,
    payload: { signature, authorization },
    ...(meta ? { meta } : {}),
  };
  return payload;
}

/**
 * Encode a payment payload as the HTTP header the client sends on
 * retry. Returns `{name, value}` so the caller can add it to its own
 * fetch headers map without guessing the name.
 */
export function encodeRetryHeader(payload: X402PaymentPayload): {
  name: 'X-PAYMENT' | 'Payment-Signature';
  value: string;
} {
  const json = JSON.stringify(payload, bigintReplacer);
  const value = base64UrlEncodeFromString(json);
  const name = payload.x402Version === 1 ? 'X-PAYMENT' : 'Payment-Signature';
  return { name, value };
}

// ─── helpers ─────────────────────────────────────────────────────────

function findHeader(
  headers: Record<string, string> | Headers,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  if (headers instanceof Headers) {
    // Headers lowercases keys; direct get works.
    return headers.get(target) ?? undefined;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

function safeParseJson(s: string, context: string): unknown {
  try {
    return JSON.parse(s);
  } catch (e) {
    throw new X402ParseError(
      `${context} is not valid JSON: ${(e as Error).message}`,
    );
  }
}

function base64UrlDecodeToString(s: string): string {
  // Accept both base64 and base64url (with or without padding).
  const normalized = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded =
    normalized.length % 4 === 0
      ? normalized
      : normalized + '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(padded, 'base64').toString('utf8');
}

function base64UrlEncodeFromString(s: string): string {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function require0x(v: unknown, field: string): `0x${string}` {
  const s = String(v);
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) {
    throw new X402ParseError(`${field} must be a 20-byte 0x address, got "${s}"`);
  }
  return s as `0x${string}`;
}

function sameAccepted(a: X402Accepted, b: X402Accepted): boolean {
  return (
    a.scheme === b.scheme &&
    a.network === b.network &&
    a.asset.toLowerCase() === b.asset.toLowerCase() &&
    a.payTo.toLowerCase() === b.payTo.toLowerCase() &&
    a.amount === b.amount
  );
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
