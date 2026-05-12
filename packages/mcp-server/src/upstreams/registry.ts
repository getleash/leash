import type { UpstreamAdapter } from './types.js';
import { agoragenticAdapter } from './agoragentic.js';
import { azursafeAdapter } from './azursafe.js';
import { coinmarketcapAdapter } from './coinmarketcap.js';
import { donate0000402Adapter } from './donate-0000402.js';
import { exaAdapter } from './exa.js';
import { gloriaAdapter } from './gloria.js';
import { invyAdapter } from './invy.js';
import { neynarAdapter } from './neynar.js';
import { oracAdapter } from './orac.js';
import { ottoaiAdapter } from './ottoai.js';

// ─── Adapter registry ────────────────────────────────────────────────
//
// Maps upstream name → protocol adapter. The policy parser derives its
// allowlist from `@getleash/core::UPSTREAM_PAYTO`, so adding a new upstream
// requires:
//   1. A payTo entry in `packages/core/src/upstream-payto.ts` (parser
//      auto-accepts the name from there).
//   2. An adapter entry in this file (runtime dispatch knows how to
//      sign + retry x402 challenges).
//
// Dropped 2026-05-12 after live mainnet smoke (D.5) — adapter files kept
// under upstreams/ as reference for re-add when the upstream operators
// update their facilitators / settlement model:
//   - browserbase:     rotates payTo per call (see task #22 + payto-rotation-design.md).
//   - robtex:          legacy v1 facilitator; strict-checks 65-byte EOA sigs.
//   - mru-oracle:      same legacy v1 facilitator issue.
//   - x402factory:     v1 facilitator returns "Failed to verify payment" — likely
//                       same legacy-1271 issue as Robtex/MRU Oracle.
//   - proxy-0000402,
//     tempfile-0000402,
//     pastebin-0000402,
//     timecapsule-0000402,
//     human-0000402:   operator-side issue. Probed cleanly (raw 402 with
//                       valid payTo + amount), but the retry returns 402
//                       with empty body. Same payTo as donate-0000402 which
//                       works — suggests the operator has x402 settlement
//                       enabled only on /donate and the other endpoints'
//                       facilitator config is incomplete.
//
// Final live-verified catalog: 10 upstreams below.
const ADAPTERS: Record<string, UpstreamAdapter> = {
  coinmarketcap: coinmarketcapAdapter,
  exa: exaAdapter,
  gloria: gloriaAdapter,
  neynar: neynarAdapter,
  orac: oracAdapter,
  agoragentic: agoragenticAdapter,
  invy: invyAdapter,
  azursafe: azursafeAdapter,
  ottoai: ottoaiAdapter,
  'donate-0000402': donate0000402Adapter,
};

export function getUpstreamAdapter(name: string): UpstreamAdapter | undefined {
  return ADAPTERS[name];
}

export function supportedUpstreamNames(): string[] {
  return Object.keys(ADAPTERS);
}
