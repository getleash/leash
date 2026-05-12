import type { HttpRestUpstreamAdapter } from './types.js';

// ─── MRU Oracle x402 (Mauritius forex + economic data + AML) ─────────
//
// Probed live 2026-05-12 against mru-oracle.com/forex.
// payTo 0x237371f8…6f75, $0.001/call, **x402 v1** (body challenge).
//
// Operator: Brightwave Solutions Ltd, Mauritius. Two products under one
// API: the Mauritius Oracle (12 economic data feeds — forex, fuel, stock
// indices, weather, macro, monetary policy, 812+ gov datasets) and
// SENTINEL (AML/CFT screening, separate host at s-e-n-t-i-n-e-l.com).
// MVP exposes the highest-utility tier-1 feeds; SENTINEL stays out of
// this adapter (different host).

export const mruOracleAdapter: HttpRestUpstreamAdapter = {
  name: 'mru-oracle',
  transport: 'http-rest',
  x402Version: 1,
  challengeLocation: 'body',
  usdcDomainSource: 'challenge-extra',
  baseUrl: 'https://mru-oracle.com',
  tools: [
    {
      name: 'get_forex_rates',
      description:
        'All MUR (Mauritian Rupee) exchange rates published by the Bank of ' +
        'Mauritius. $0.001 / call. Use this for FX context across major pairs.',
      inputSchema: { type: 'object', properties: {} },
      method: 'GET',
      path: '/forex',
    },
    {
      name: 'get_forex_pair',
      description:
        'A specific MUR exchange rate (e.g. MUR/USD, MUR/EUR). $0.001 / call.',
      inputSchema: {
        type: 'object',
        properties: {
          currency: {
            type: 'string',
            description: 'Three-letter currency code (USD, EUR, GBP, etc.).',
          },
        },
        required: ['currency'],
      },
      method: 'GET',
      path: '/forex/{currency}',
    },
    {
      name: 'get_fuel_prices',
      description: 'Current fuel prices in Mauritius. $0.001 / call.',
      inputSchema: { type: 'object', properties: {} },
      method: 'GET',
      path: '/fuel',
    },
  ],
};
