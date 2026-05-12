import type { Address } from 'viem';
import type { ChainName } from './types.js';

// ─── Static payTo registry for curated upstreams ─────────────────────
//
// The SessionKeyValidator's 1271 path enforces a per-recipient amount cap
// on-chain (see `summary/eip3009-policy-enforcement.md`). To install that
// cap at `leash apply` time we need each upstream's settlement address
// (the `payTo` in their x402 challenge) before the very first call.
//
// MVP ships these statically. Phase D adds `leash apply --probe` which
// hits each upstream's 402 endpoint and verifies the live `payTo` matches
// this table — a mismatch means either the upstream rotated their
// settlement address (rare) or something is impersonating it (concerning).
//
// Update procedure when an upstream's address changes:
//   1. Verify the new address via the upstream's documentation + a fresh
//      `curl` against their MCP endpoint.
//   2. Update the entry here.
//   3. Note the rotation in `summary/upstreams-catalog.md` (Phase D).
//   4. Bump the package version and document in the changelog so existing
//      `leash apply` runs surface the change.

export interface UpstreamPayTo {
  /** Production Base mainnet address. */
  base: Address;
  /** Optional Base Sepolia testnet address (for Phase 5.x test deploys). */
  baseSepolia?: Address;
}

export const UPSTREAM_PAYTO: Record<string, UpstreamPayTo> = {
  // CMC x402: verified live on Base mainnet 2026-04-14 in PoC-B.
  coinmarketcap: {
    base: '0x271189c860DB25bC43173B0335784aD68a680908',
  },
  // Neynar (Farcaster social): probed 2026-05-12 against api.neynar.com.
  // Captured 402 at /v2/farcaster/user/bulk → cost $0.01/call.
  // Fixture: tests/fixtures/upstream-probes/neynar.json.
  neynar: {
    base: '0xA6a8736f18f383f1cc2d938576933E5eA7Df01A1',
  },
  // Gloria AI (real-time news): probed 2026-05-12 against api.itsgloria.ai.
  // Captured 402 at /news → cost $0.03/call.
  // Fixture: tests/fixtures/upstream-probes/gloria.json.
  gloria: {
    base: '0xCa1271E777C209e171826A681855351f4989cd0c',
  },
  // Browserbase: DROPPED 2026-05-12 after smoke surfaced that they rotate the
  // payTo address on every call (`0xe82B35C8…AE898` → `0xE85397…AE4e` →
  // `0xb98D1a02…3627` → `0x3c184Abc…A2b7` observed across three calls). This
  // is fundamentally incompatible with the witness validator's pre-installed
  // `maxValueByRecipient` allowlist. See task #22 for the future
  // wildcard-cap / lazy-install approach that could re-enable them.
  // Exa (AI-powered web search): verified 2026-05-12 against api.exa.ai/search.
  // v2 protocol with header challenge (`payment-required` base64 JSON).
  exa: {
    base: '0x6d6E695b09861467c7d462f5AAF31cF3540B9192',
  },
  // Robtex: DROPPED 2026-05-12 — runs a legacy self-hosted v1 facilitator
  // that strict-checks 65-byte EOA sigs and rejects the 246-byte witness sig
  // with "invalid signature length". See `summary/x402-v1-contract-sig-findings.md`.
  // Orac (AI safety / prompt-injection scan): verified 2026-05-12 against
  // orac-safety.orac.workers.dev/v1/scan. v2 body challenge.
  orac: {
    base: '0x4a47B25c90eA79e32b043d9eE282826587187ca5',
  },
  // Agoragentic (document summarization + web scraping + receipt + audit):
  // verified 2026-05-12 against x402.agoragentic.com/v1/text-summarizer.
  // v2 body challenge.
  agoragentic: {
    base: '0xadB33740Ac38c8F6721100Ff813ab91d958670BC',
  },
  // Invy (onchain wallet lookup, EVM + Solana): verified 2026-05-12
  // against invy.bot/api/v1/wallet?address=…. v2 protocol with header
  // challenge. Multi-network accepts[] array; filter to eip155:8453.
  invy: {
    base: '0x19c5fbc520a3a8c2fa440148193de4543a5fc66a',
  },
  // AzurSafe (wallet/identity risk screening, 30+ chains): verified
  // 2026-05-12 against ai.azursafe.com/agent/screen-id?identifier=…
  // v2 body challenge.
  azursafe: {
    base: '0xbc9FFC87e32BC848280ad4511c4a930AFc5946bD',
  },
  // MRU Oracle: DROPPED 2026-05-12 — same legacy v1 facilitator issue as
  // Robtex (silently re-issues 402 instead of accepting the witness sig).
  // See `summary/x402-v1-contract-sig-findings.md`.
  // OttoAI (EVM transaction + token explainer, 11 chains): verified
  // 2026-05-12 against x402.ottoai.services/token-details. v2 body challenge.
  ottoai: {
    base: '0x0E84dDEdAaE6A779c462C22a59F301EC31B6b808',
  },
  // donate-0000402 — live x402 integration test endpoint from the
  // 0000402.xyz operator family. Verified end-to-end live on Base mainnet
  // 2026-05-12 (D.5+D.8 smoke). $0.01/call, v2 (body).
  //
  // Sibling endpoints from the same operator (proxy, tempfile, pastebin,
  // timecapsule, human) DROPPED 2026-05-12 — they returned 402 with empty
  // body on retry despite probing cleanly. Operator's facilitator appears
  // to be configured only on /donate; other endpoints' settlement is
  // incomplete. See registry.ts for the full deferred list.
  //
  // x402factory.ai — DROPPED 2026-05-12, v1 facilitator returns "Failed to
  // verify payment: Bad Request" on the witness sig (same legacy-1271 issue
  // as Robtex/MRU Oracle).
  'donate-0000402': {
    base: '0xeE72B902Af7466023595512e3359BB5bF312977c',
  },
};

/**
 * Resolve an upstream's `payTo` for a given chain.
 *
 * Returns `undefined` if the upstream is unknown to this build, or if it's
 * known but has no address registered for the target chain. Callers should
 * surface this as a config error (the validator install must include every
 * upstream's recipient, or payments to that upstream will fail with the
 * on-chain `cap == 0` rejection).
 */
export function resolveUpstreamPayTo(
  upstreamName: string,
  chain: ChainName,
): Address | undefined {
  const entry = UPSTREAM_PAYTO[upstreamName];
  if (!entry) return undefined;
  if (chain === 'base') return entry.base;
  if (chain === 'base-sepolia') return entry.baseSepolia;
  return undefined;
}
