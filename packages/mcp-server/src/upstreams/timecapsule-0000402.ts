import type { HttpRestUpstreamAdapter } from './types.js';

// ─── timecapsule.0000402.xyz (time-locked text) ──────────────────────
//
// Verified live 2026-05-12. v2 (body challenge). $0.05/call.
// payTo 0xeE72B902…77c (shared with 0000402.xyz operator family).
//
// Seal up to 100 KB of text until a future date. Inaccessible via
// GET /open/{token} until unlock_at passes. Max unlock: 10 years.

export const timecapsule0000402Adapter: HttpRestUpstreamAdapter = {
  name: 'timecapsule-0000402',
  transport: 'http-rest',
  x402Version: 2,
  challengeLocation: 'body',
  usdcDomainSource: 'challenge-extra',
  baseUrl: 'https://timecapsule.0000402.xyz',
  tools: [
    {
      name: 'seal',
      description:
        'Seal a text capsule (up to 100 KB) until a future unix timestamp. ' +
        'An optional label is visible before unlock via GET /status/{token}. $0.05/call.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          unlock_at: { type: 'number', description: 'Unix timestamp (seconds) when the capsule unlocks.' },
          label: { type: 'string', description: 'Optional public label.' },
        },
        required: ['text', 'unlock_at'],
      },
      method: 'POST',
      path: '/seal',
    },
  ],
};
