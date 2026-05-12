import type { HttpRestUpstreamAdapter } from './types.js';

// ─── human.0000402.xyz (ask-a-human queue) ───────────────────────────
//
// Verified live 2026-05-12. v2 (body challenge). $0.10/call.
// payTo 0xeE72B902…77c (shared with 0000402.xyz operator family).
//
// Submit a question to a real human community (Discord + Telegram).
// Returns a token to poll for responses. Useful for human-in-the-loop
// review steps in agent workflows.

export const human0000402Adapter: HttpRestUpstreamAdapter = {
  name: 'human-0000402',
  transport: 'http-rest',
  x402Version: 2,
  challengeLocation: 'body',
  usdcDomainSource: 'challenge-extra',
  baseUrl: 'https://human.0000402.xyz',
  tools: [
    {
      name: 'ask',
      description:
        'Submit a question to a live human community. Returns a token to poll for ' +
        'responses (via GET /status/{token} and /responses/{token}). Status becomes ' +
        '"ready" once at least 1 human response is collected. Max question length: ' +
        '2000 chars. $0.10/call.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question text.' },
        },
        required: ['question'],
      },
      method: 'POST',
      path: '/ask',
    },
  ],
};
