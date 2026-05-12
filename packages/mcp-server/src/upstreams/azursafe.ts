import type { HttpRestUpstreamAdapter } from './types.js';

// ─── AzurSafe x402 (wallet/identity risk screening) ──────────────────
//
// Probed live 2026-05-12 against ai.azursafe.com/agent/screen-id.
// payTo 0xbc9FFC87…46bD, $0.01/call, x402 v2 (body challenge).
//
// AzurSafe screens identifiers — primarily blockchain wallet addresses
// (30+ chains: EVM, UTXO/BTC, Solana, XRP, Tron, etc.) plus domains,
// emails, phone numbers, and usernames. Real-time risk score for AML /
// sanctions / abuse intelligence.

export const azursafeAdapter: HttpRestUpstreamAdapter = {
  name: 'azursafe',
  transport: 'http-rest',
  x402Version: 2,
  challengeLocation: 'body',
  usdcDomainSource: 'challenge-extra',
  baseUrl: 'https://ai.azursafe.com',
  tools: [
    {
      name: 'screen_identifier',
      description:
        'Run a risk screen on a wallet address, domain, email, phone, or ' +
        'username. Supports 30+ blockchains plus off-chain identifiers. ' +
        'Returns a risk score + reasoning. $0.01 / call.',
      inputSchema: {
        type: 'object',
        properties: {
          identifier: {
            type: 'string',
            description:
              'The identifier to screen — a wallet address, domain, email, ' +
              'phone, or username.',
          },
        },
        required: ['identifier'],
      },
      method: 'GET',
      path: '/agent/screen-id',
    },
  ],
};
