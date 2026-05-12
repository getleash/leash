import type { HttpRestUpstreamAdapter } from './types.js';

// ─── donate.0000402.xyz (live x402 integration test / donation) ──────
//
// Verified live 2026-05-12. v2 (body challenge). $0.01/call.
// payTo 0xeE72B902…77c (shared with 0000402.xyz operator family).
//
// Lightweight live-x402 test endpoint. Send an optional name + message;
// $0.01 USDC is donated to the operator. The donation is recorded
// publicly at GET /donations. Useful as a "does my integration work"
// smoke test before wiring up a more expensive upstream.

export const donate0000402Adapter: HttpRestUpstreamAdapter = {
  name: 'donate-0000402',
  transport: 'http-rest',
  x402Version: 2,
  challengeLocation: 'body',
  usdcDomainSource: 'challenge-extra',
  baseUrl: 'https://donate.0000402.xyz',
  tools: [
    {
      name: 'donate',
      description:
        'Pay $0.01 USDC as a small donation or a simple live x402 integration test. ' +
        'Optional name and message are stored publicly and shown on GET /donations.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Optional public donor name.' },
          message: { type: 'string', description: 'Optional public message.' },
        },
      },
      method: 'POST',
      path: '/donate',
    },
  ],
};
