import type { HttpRestUpstreamAdapter } from './types.js';

// ─── OttoAI x402 (EVM transaction + token explainer, 11 chains) ──────
//
// Probed live 2026-05-12 against x402.ottoai.services/token-details.
// payTo 0x0E84dDEd…b808, $0.10/call, x402 v2 (body challenge).
//
// Supports Base, Ethereum, Arbitrum, Optimism, Avalanche, Polygon,
// Mantle, Monad, Plasma, BSC, Hyperliquid. The full available endpoint
// list was returned by the 404 path: crypto-news, filtered-news,
// twitter-summary, token-details, token-alpha, kol-sentiment, etc-news,
// contract-info-decoder, tweet-x-context, wallet-info-decoder,
// crypto-meme-decoder, etc-decoder.

export const ottoaiAdapter: HttpRestUpstreamAdapter = {
  name: 'ottoai',
  transport: 'http-rest',
  x402Version: 2,
  challengeLocation: 'body',
  usdcDomainSource: 'challenge-extra',
  baseUrl: 'https://x402.ottoai.services',
  tools: [
    {
      name: 'token_details',
      description:
        'Fetch ERC-20 / SPL token details (supply, holders, deployer, ' +
        'verified status) for any address across 11 supported chains. ' +
        '$0.10 / call.',
      inputSchema: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'Token contract address.' },
          chain: {
            type: 'string',
            description: 'Chain identifier (base, ethereum, arbitrum, optimism, polygon, etc.).',
          },
        },
        required: ['address', 'chain'],
      },
      method: 'GET',
      path: '/token-details',
    },
    {
      name: 'contract_info_decoder',
      description:
        'Decode a smart-contract address into a human-readable summary of ' +
        'its purpose, ownership, and key functions. $0.10 / call.',
      inputSchema: {
        type: 'object',
        properties: {
          address: { type: 'string' },
          chain: { type: 'string' },
        },
        required: ['address', 'chain'],
      },
      method: 'GET',
      path: '/contract-info-decoder',
    },
    {
      name: 'wallet_info_decoder',
      description:
        'Human-readable summary of a wallet address — labels, recent activity, ' +
        'category tags. $0.10 / call.',
      inputSchema: {
        type: 'object',
        properties: {
          address: { type: 'string' },
          chain: { type: 'string' },
        },
        required: ['address', 'chain'],
      },
      method: 'GET',
      path: '/wallet-info-decoder',
    },
  ],
};
