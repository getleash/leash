import type { Address, Hex } from 'viem';

// ─── Policy Types ────────────────────────────────────────────────────
//
// Shape matches examples/cryptonit/cryptonit-policy.md (Phase 0 frozen).
// All amounts are USDC base units (6 decimals) bigint; convert at
// presentation boundary only.

/** Canonical chain name. Only 'base' is supported on the MVP hot path. */
export type ChainName = 'base' | 'base-sepolia';

/** One curated upstream the agent is allowed to pay. */
export interface PolicyUpstream {
  name: string;
  url: string;
  namespace: string;
  /**
   * Optional per-upstream amount cap (USDC base units). When set, this is
   * installed as the recipient's on-chain cap in the SessionKeyValidator's
   * `maxValueByRecipient` mapping; the validator's 1271 path rejects any
   * EIP-3009 authorization to this upstream's `payTo` above this cap.
   *
   * Unset means "fall back to `limits.maxPerTransaction`" — the policy's
   * global per-tx cap doubles as the per-recipient cap for upstreams that
   * don't tighten it.
   */
  maxPerCall?: bigint;
}

/** Optional named transfer counterparty (used by the `transfer` own-tool). */
export interface PolicyCounterparty {
  name: string;
  address: Address;
}

/** Daily / weekly / monthly caps (USDC base units). */
export interface PolicyLimits {
  maxPerTransaction: bigint;
  daily: bigint;
  weekly: bigint;
  monthly: bigint;
}

/**
 * Parsed agent policy. `drainToHub` is mandatory and always `true` once
 * parsed — the parser rejects any policy that omits the ## Recovery
 * section (see summary/errors.md §3 "missing required section").
 */
export interface AgentPolicy {
  name: string;
  chain: ChainName;
  validityDays: number;
  /** Initial USDC to move hub → sub on `leash apply`. */
  initialFunding: bigint;
  limits: PolicyLimits;
  upstreams: PolicyUpstream[];
  drainToHub: true;
  counterparties: PolicyCounterparty[];
}

// ─── Authorization Grant (seed; see summary/authorization-object.md) ─
//
// First-class representation of what the principal has authorized the
// agent to do. The on-chain session-key whitelist is a projection of
// this; the markdown policy is the human source of truth; the signed
// x402 payments reference its `id`. Phase 4 defines the type; later
// phases fill in the signing / revocation surface.

export interface AuthorizationGrant {
  /** Stable UUID (v7) minted by `leash apply`. Used for audit + revocation. */
  id: string;
  principal: Address;
  /** The session key pubkey (session key = the bearer of this grant). */
  agent: Address;
  /** The sub-account this grant operates from. */
  subAccount: Address;
  chain: ChainName;
  validFrom: number; // unix seconds
  validUntil: number; // unix seconds
  /** Human-readable intent; not used for enforcement. */
  purpose: string;
  limits: PolicyLimits;
  upstreams: PolicyUpstream[];
  counterparties: PolicyCounterparty[];
  /** keccak256 of the policy markdown (UTF-8 bytes). Integrity anchor. */
  policyHash: Hex;
  /** Populated by `leash revoke` — marks the grant as principal-revoked. */
  revokedAt?: number;
}

/** A grant + principal's EIP-712 signature. See summary/authorization-object.md. */
export interface SignedAuthorizationGrant {
  grant: AuthorizationGrant;
  /** EIP-712 signature over the canonical typed-data digest, signed by `grant.principal`. */
  signature: Hex;
}

// ─── x402 Types ──────────────────────────────────────────────────────
//
// Shape normalized across v1 and v2 per PoC-B (see poc/b-x402-proxy/findings.md).
// CMC (the flagship upstream) ships v2 with the challenge in the
// `Payment-Required` HTTP header, not the body.

export type X402Scheme = 'exact';

export type X402Network =
  | 'base'           // v1 shorthand
  | 'base-sepolia'   // v1 shorthand
  | 'eip155:8453'    // v2 CAIP-2
  | 'eip155:84532';  // v2 CAIP-2

/** A single accepted-payment terms block returned by the upstream. */
export interface X402Accepted {
  scheme: X402Scheme;
  network: X402Network;
  /** USDC contract address. */
  asset: Address;
  /** Decimal string (USDC base units), e.g. "10000" = 0.01 USDC. */
  amount: string;
  payTo: Address;
  maxTimeoutSeconds: number;
  extra?: {
    name?: string;     // USDC EIP-712 domain name, e.g. "USD Coin"
    version?: string;  // USDC EIP-712 domain version, e.g. "2"
    [k: string]: unknown;
  };
}

/** The full 402 challenge (v1 body or v2 header, normalized). */
export interface X402Challenge {
  x402Version: 1 | 2;
  error: string;
  /** Present in v2 responses; echo back in the `accepted` field verbatim. */
  resource?: { url: string; description?: string };
  accepts: X402Accepted[];
  /** Where the challenge arrived — client needs this to retry correctly. */
  source: 'body' | 'header';
  /** Which retry header to use: `X-PAYMENT` (v1) or `Payment-Signature` (v2). */
  retryHeader: 'X-PAYMENT' | 'Payment-Signature';
}

/** The signed EIP-3009 authorization the client sends back on retry. */
export interface X402Authorization {
  from: Address;
  to: Address;
  /** Decimal string. */
  value: string;
  /** Decimal string (unix seconds). */
  validAfter: string;
  /** Decimal string (unix seconds). */
  validBefore: string;
  /** 32-byte random nonce. */
  nonce: Hex;
}

/**
 * Leash-specific x402 metadata, carried on retry in `payload.meta.leash`.
 * Facilitators JSON-pass `meta` through; counterparties that want to
 * verify the authorization chain can inspect it; naive counterparties
 * ignore it. See summary/authorization-object.md §"Reference".
 */
export interface X402LeashMeta {
  grantId: string;
  /**
   * How the counterparty obtains the full SignedAuthorizationGrant.
   * `inline` embeds it in the header (MVP default); a future `url`
   * variant keeps big grants out of the hot path.
   */
  grantRef?:
    | { inline: SignedAuthorizationGrant }
    | { url: string };
}

/** Retry payload, v1 or v2. Shape diverges; the builder picks the right one. */
export type X402PaymentPayloadV1 = {
  x402Version: 1;
  scheme: X402Scheme;
  network: X402Network;
  payload: {
    signature: Hex;
    authorization: X402Authorization;
  };
  meta?: { leash?: X402LeashMeta; [k: string]: unknown };
};

export type X402PaymentPayloadV2 = {
  x402Version: 2;
  /**
   * Echoed back from the challenge when present. Optional because some
   * v2-publishing upstreams (eg. invy) omit it; the facilitator accepts
   * the retry without echo as long as the rest of the payload matches.
   */
  resource?: X402Challenge['resource'];
  /** Mirrors the challenge's chosen accept terms verbatim. */
  accepted: X402Accepted;
  payload: {
    signature: Hex;
    authorization: X402Authorization;
  };
  meta?: { leash?: X402LeashMeta; [k: string]: unknown };
};

export type X402PaymentPayload = X402PaymentPayloadV1 | X402PaymentPayloadV2;

// ─── Session Key (agent-side) ────────────────────────────────────────

export interface SessionKeyEntry {
  privateKey: Hex;
  address: Address;
  subAccount: Address;
  validUntil: number; // unix seconds
  targets: Address[];
  selectors: Hex[];
  createdAt: string; // ISO 8601
}

// ─── UserOp (EntryPoint v0.7) ────────────────────────────────────────

export interface PackedUserOperation {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  /** verificationGasLimit (16B) || callGasLimit (16B). */
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  /** maxPriorityFeePerGas (16B) || maxFeePerGas (16B). */
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}

// ─── Policy-check result ─────────────────────────────────────────────

/**
 * Result of the pre-sign local policy check. On denial, the MCP
 * surface converts `denialCode` into the structured MCP error envelope
 * (see summary/errors.md §1 catalogue).
 */
export type PolicyCheckResult =
  | { ok: true }
  | {
      ok: false;
      /** Canonical error code from summary/errors.md. */
      denialCode: MCPErrorCode;
      /** Code-specific detail shape (see api-design.md). */
      details: Record<string, unknown>;
    };

// ─── MCP Error Envelope (summary/errors.md §1) ───────────────────────

export type MCPErrorCategory =
  | 'auth'
  | 'budget'
  | 'funds'
  | 'upstream'
  | 'config'
  | 'network';

export type MCPErrorCode =
  | 'OVER_PER_TX_CAP'
  | 'OVER_DAILY_CAP'
  | 'OVER_WEEKLY_CAP'
  | 'OVER_MONTHLY_CAP'
  | 'RECIPIENT_NOT_ALLOWLISTED'
  | 'SESSION_KEY_EXPIRED'
  | 'ON_CHAIN_REVOKED'
  | 'INSUFFICIENT_FUNDS'
  | 'UPSTREAM_UNAVAILABLE'
  | 'FACILITATOR_REJECTED'
  | 'CONFIG_MISSING';

export interface MCPError {
  isError: true;
  content: [{ type: 'text'; text: string }];
  structuredContent: {
    code: MCPErrorCode;
    category: MCPErrorCategory;
    details: Record<string, unknown>;
    suggested_action: string;
  };
}

// ─── Transaction log (SQLite) ────────────────────────────────────────

export interface TransactionRecord {
  id?: number;
  timestamp: string; // ISO 8601
  kind: 'x402_payment' | 'userop';
  amount: bigint; // USDC base units
  recipient: Address;
  upstream?: string;
  /** Present for x402; hex of the signed EIP-3009 digest. */
  authorizationDigest?: Hex;
  /** Present for UserOps. */
  userOpHash?: Hex;
  txHash?: Hex;
  status: 'pending' | 'confirmed' | 'failed';
  blockNumber?: number;
  gasUsed?: bigint;
  grantId?: string; // ties back to the AuthorizationGrant
}
