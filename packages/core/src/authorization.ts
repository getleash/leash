import {
  type Address,
  type Hex,
  type TypedData,
  type TypedDataDomain,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  toBytes,
  verifyTypedData,
} from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { getChainConfig } from './constants.js';
import type {
  AuthorizationGrant,
  ChainName,
  PolicyCounterparty,
  PolicyUpstream,
  SignedAuthorizationGrant,
} from './types.js';

// ─── EIP-712 typed-data definition ───────────────────────────────────
//
// Domain is { name: "Leash", version: "1", chainId } — NO
// verifyingContract. Rationale in summary/authorization-object.md
// §"EIP-712 typed data" (TL;DR: LeashFactory isn't deployed at apply
// time on a fresh machine, and chain-bound contract-free signatures
// survive factory re-deploys).
//
// Arrays (`upstreams`, `counterparties`) are canonicalized — sorted
// by `name` ascending — before hashing. Defensive move so two policies
// with equivalent content but different line order produce the same
// signature. See `canonicalizeGrant` below.

export const LEASH_AUTHORIZATION_DOMAIN_NAME = 'Leash';
export const LEASH_AUTHORIZATION_DOMAIN_VERSION = '1';

const AUTHORIZATION_TYPES = {
  AuthorizationGrant: [
    { name: 'id', type: 'string' },
    { name: 'principal', type: 'address' },
    { name: 'agent', type: 'address' },
    { name: 'subAccount', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'validFrom', type: 'uint48' },
    { name: 'validUntil', type: 'uint48' },
    { name: 'purpose', type: 'string' },
    { name: 'limits', type: 'Limits' },
    { name: 'upstreams', type: 'Upstream[]' },
    { name: 'counterparties', type: 'Counterparty[]' },
    { name: 'policyHash', type: 'bytes32' },
  ],
  Limits: [
    { name: 'maxPerTransaction', type: 'uint256' },
    { name: 'daily', type: 'uint256' },
    { name: 'weekly', type: 'uint256' },
    { name: 'monthly', type: 'uint256' },
  ],
  Upstream: [
    { name: 'name', type: 'string' },
    { name: 'url', type: 'string' },
    { name: 'namespace', type: 'string' },
  ],
  Counterparty: [
    { name: 'name', type: 'string' },
    // `address` is a reserved word in Solidity but a valid EIP-712
    // field name. viem handles it without escaping.
    { name: 'address', type: 'address' },
  ],
} as const satisfies TypedData;

/** Map a chain name to the numeric id the EIP-712 domain uses. */
function chainNameToId(chain: ChainName): number {
  return getChainConfig(chain).chainId;
}

/**
 * Compute the policyHash a grant should carry.
 *
 * Intentionally a thin wrapper — the operation is `keccak256(utf8)` —
 * but named so call sites read clearly and future changes land in one
 * place.
 */
export function hashPolicyMarkdown(markdown: string): Hex {
  return keccak256(toBytes(markdown));
}

// ─── Canonicalization ────────────────────────────────────────────────

function sortByName<T extends { name: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Canonical form of a grant — same content, deterministic array
 * order. Sign / verify always run on the canonical form so that
 * equivalent policies produce equivalent signatures.
 */
export function canonicalizeGrant(grant: AuthorizationGrant): AuthorizationGrant {
  return {
    ...grant,
    upstreams: sortByName<PolicyUpstream>(grant.upstreams),
    counterparties: sortByName<PolicyCounterparty>(grant.counterparties),
  };
}

// ─── Typed-data assembly ─────────────────────────────────────────────

interface AssembledTypedData {
  domain: TypedDataDomain;
  types: typeof AUTHORIZATION_TYPES;
  primaryType: 'AuthorizationGrant';
  message: Record<string, unknown>;
}

function assembleTypedData(grant: AuthorizationGrant): AssembledTypedData {
  const c = canonicalizeGrant(grant);
  const chainId = chainNameToId(c.chain);
  return {
    domain: {
      name: LEASH_AUTHORIZATION_DOMAIN_NAME,
      version: LEASH_AUTHORIZATION_DOMAIN_VERSION,
      chainId: BigInt(chainId),
    },
    types: AUTHORIZATION_TYPES,
    primaryType: 'AuthorizationGrant',
    message: {
      id: c.id,
      principal: c.principal,
      agent: c.agent,
      subAccount: c.subAccount,
      chainId: BigInt(chainId),
      validFrom: c.validFrom,
      validUntil: c.validUntil,
      purpose: c.purpose,
      limits: {
        maxPerTransaction: c.limits.maxPerTransaction,
        daily: c.limits.daily,
        weekly: c.limits.weekly,
        monthly: c.limits.monthly,
      },
      upstreams: c.upstreams,
      counterparties: c.counterparties,
      policyHash: c.policyHash,
    },
  };
}

/**
 * Compute the EIP-712 digest for a grant. Deterministic — the same
 * input (modulo non-canonical array order) produces the same hash.
 */
export function hashAuthorizationGrant(grant: AuthorizationGrant): Hex {
  const td = assembleTypedData(grant);
  return hashTypedData({
    domain: td.domain,
    types: td.types,
    primaryType: td.primaryType,
    message: td.message,
  } as Parameters<typeof hashTypedData>[0]);
}

// ─── Sign ────────────────────────────────────────────────────────────

/**
 * Sign a grant with the hub owner's key. Returns the
 * {grant, signature} bundle stored in `.leash/agent/<name>/grant.json`.
 *
 * Asserts `account.address === grant.principal` — prevents accidentally
 * signing with the wrong key (which would verify-fail everywhere
 * downstream but fail silently here).
 */
export async function signAuthorizationGrant(
  grant: AuthorizationGrant,
  hubOwner: PrivateKeyAccount,
): Promise<SignedAuthorizationGrant> {
  if (hubOwner.address.toLowerCase() !== grant.principal.toLowerCase()) {
    throw new Error(
      `signAuthorizationGrant: hub owner ${hubOwner.address} does not match ` +
        `grant.principal ${grant.principal}`,
    );
  }
  const td = assembleTypedData(grant);
  const signature = await hubOwner.signTypedData({
    domain: td.domain,
    types: td.types,
    primaryType: td.primaryType,
    message: td.message,
  } as Parameters<PrivateKeyAccount['signTypedData']>[0]);
  return { grant: canonicalizeGrant(grant), signature };
}

// ─── Verify (pure — no RPC) ──────────────────────────────────────────

export type VerifyGrantResult =
  | { ok: true; signer: Address }
  | { ok: false; reason: string };

/**
 * Verify the signature on a grant. Pure — does NOT check on-chain
 * revocation or expiry against wall-clock time. For full
 * counterparty verification, compose this with an on-chain read
 * against `SessionKeyValidator` + `LeashFactory` (see
 * summary/authorization-object.md §"Verification").
 */
export async function verifyAuthorizationGrantSignature(
  signed: SignedAuthorizationGrant,
): Promise<VerifyGrantResult> {
  const td = assembleTypedData(signed.grant);

  const valid = await verifyTypedData({
    address: signed.grant.principal,
    domain: td.domain,
    types: td.types,
    primaryType: td.primaryType,
    message: td.message,
    signature: signed.signature,
  } as Parameters<typeof verifyTypedData>[0]);

  if (!valid) {
    return { ok: false, reason: 'signature does not verify against grant.principal' };
  }

  const recovered = await recoverTypedDataAddress({
    domain: td.domain,
    types: td.types,
    primaryType: td.primaryType,
    message: td.message,
    signature: signed.signature,
  } as Parameters<typeof recoverTypedDataAddress>[0]);

  return { ok: true, signer: recovered };
}

// ─── ID minting ──────────────────────────────────────────────────────

/**
 * Produce a UUID v7 suitable for `AuthorizationGrant.id`. v7 is
 * time-ordered — grants sort naturally in logs.
 *
 * Inlined (no uuid dep) because it's a dozen lines of glue. `crypto`
 * is Node's built-in.
 */
export function mintGrantId(): string {
  // 48 bits of unix millis, 4 bits version (7), 12 bits random, 2 bits variant (10),
  // 62 bits random. Layout per RFC 9562.
  const nowMs = BigInt(Date.now());
  const rand = crypto.getRandomValues(new Uint8Array(10));

  // timestamp: bytes [0:6]
  const b = new Uint8Array(16);
  b[0] = Number((nowMs >> 40n) & 0xffn);
  b[1] = Number((nowMs >> 32n) & 0xffn);
  b[2] = Number((nowMs >> 24n) & 0xffn);
  b[3] = Number((nowMs >> 16n) & 0xffn);
  b[4] = Number((nowMs >> 8n) & 0xffn);
  b[5] = Number(nowMs & 0xffn);
  // version 7 in high nibble of byte 6, random in low nibble
  b[6] = 0x70 | (rand[0] & 0x0f);
  b[7] = rand[1];
  // variant 10xx in high bits of byte 8
  b[8] = 0x80 | (rand[2] & 0x3f);
  b[9] = rand[3];
  b[10] = rand[4];
  b[11] = rand[5];
  b[12] = rand[6];
  b[13] = rand[7];
  b[14] = rand[8];
  b[15] = rand[9];

  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20, 32)}`;
}
