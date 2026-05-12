#!/usr/bin/env tsx
// Regenerate examples/verify-grant/sample-grant.json.
// Run with: `npx tsx generate-sample.ts > sample-grant.json`.
//
// The sample uses a well-known test private key so the signer is
// deterministic — don't ever use this key for anything real.

import { privateKeyToAccount } from 'viem/accounts';
import {
  hashPolicyMarkdown,
  signAuthorizationGrant,
} from '@getleash/core';
import type { AuthorizationGrant } from '@getleash/core';

// Deterministic test key. NEVER use for anything holding value.
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const principal = privateKeyToAccount(TEST_KEY);

const SAMPLE_POLICY = `# Agent Policy
name: cryptonit
chain: base
validity: 30 days
initial_funding: 1.00 USDC

## Limits
max_per_transaction: 0.10 USDC
daily_limit:         1.00 USDC
weekly_limit:        5.00 USDC
monthly_limit:      15.00 USDC

## Upstreams
- name: coinmarketcap
  url: https://mcp.coinmarketcap.com/x402/mcp
  namespace: coinmarketcap

## Recovery
drain_to_hub: enabled
`;

const grant: AuthorizationGrant = {
  id: '0199c0de-0000-7000-8000-000000000001',
  principal: principal.address,
  agent: '0x6C718844Aaa21cAad240C2F968173095f62b40D9',
  subAccount: '0x6bD660201f64De3064D94Be02D3EaFb5978F2022',
  chain: 'base',
  validFrom: 1_760_000_000,
  validUntil: 1_762_592_000,
  purpose: 'Pay CoinMarketCap Pro per-call for market data.',
  limits: {
    maxPerTransaction: 100_000n,
    daily: 1_000_000n,
    weekly: 5_000_000n,
    monthly: 15_000_000n,
  },
  upstreams: [
    {
      name: 'coinmarketcap',
      url: 'https://mcp.coinmarketcap.com/x402/mcp',
      namespace: 'coinmarketcap',
    },
  ],
  counterparties: [],
  policyHash: hashPolicyMarkdown(SAMPLE_POLICY),
};

const signed = await signAuthorizationGrant(grant, principal);

// Serialize with bigints as strings.
const json = JSON.stringify(
  signed,
  (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
  2,
);
console.log(json);
