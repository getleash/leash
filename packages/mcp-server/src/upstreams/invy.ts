import type { HttpRestUpstreamAdapter } from './types.js';

// ─── Invy x402 (onchain wallet lookup, EVM + Solana) ─────────────────
//
// Probed live 2026-05-12 against invy.bot/api/v1/wallet?address=…
// payTo 0x19c5fbc5…fc66a, $0.05/call, x402 v2 (header challenge —
// the 402 body is empty; the challenge lives in `payment-required` header).
//
// Quirk: invy publishes a multi-network `accepts[]` array (Base + Ethereum
// mainnet + Solana). The proxy must filter to `eip155:8453` when picking
// the accept. @getleash/core's parseX402Challenge takes the first match;
// callers using Leash on Base will always land on the eip155:8453 entry
// because UPSTREAM_PAYTO's `base` field is what's installed in the
// SessionKeyValidator. Cross-chain mismatches would fail on-chain anyway.

export const invyAdapter: HttpRestUpstreamAdapter = {
  name: 'invy',
  transport: 'http-rest',
  x402Version: 2,
  challengeLocation: 'header',
  usdcDomainSource: 'challenge-extra',
  baseUrl: 'https://invy.bot',
  tools: [
    {
      name: 'wallet_lookup',
      description:
        'Fetch onchain activity summary for a wallet address. Supports ' +
        'EVM (Base + Ethereum) and Solana. $0.05 / call. Returns balances, ' +
        'recent transactions, holdings, and basic risk signals.',
      inputSchema: {
        type: 'object',
        properties: {
          address: {
            type: 'string',
            description: 'EVM (0x-prefixed) or Solana (base58) address.',
          },
        },
        required: ['address'],
      },
      method: 'GET',
      path: '/api/v1/wallet',
    },
  ],
};
