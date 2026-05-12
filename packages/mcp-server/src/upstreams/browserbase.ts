import type { HttpRestUpstreamAdapter } from './types.js';

// ─── Browserbase x402 ────────────────────────────────────────────────
//
// Headless browser sessions priced per minute. Verified live 2026-05-12
// against `x402.browserbase.com/browser/session/create` — returned a
// clean v1 x402 challenge (body delivery, X-PAYMENT header on retry)
// with payTo 0xe82B35C8…AE898 and a cost of 10000 base units ($0.01)
// per 5 estimated minutes (~$0.12/hour).
//
// The captured 402 fixture is at
// `tests/fixtures/upstream-probes/browserbase.json`. PoC-B's CMC flow
// gives us the v2 reference; this is Leash's first v1 upstream.

export const browserbaseAdapter: HttpRestUpstreamAdapter = {
  name: 'browserbase',
  transport: 'http-rest',
  x402Version: 1,
  challengeLocation: 'body',
  usdcDomainSource: 'challenge-extra',
  baseUrl: 'https://x402.browserbase.com',
  tools: [
    {
      name: 'create_session',
      description:
        'Start a Browserbase headless browser session. Cost is 10000 ' +
        'USDC base units ($0.01) per 5 estimated minutes. The response ' +
        'returns connection details (CDP URL + session ID) the agent ' +
        'can drive with Puppeteer / Playwright / a Chrome MCP.',
      inputSchema: {
        type: 'object',
        properties: {
          estimatedMinutes: {
            type: 'number',
            description:
              'How long the session is expected to run. Drives the upfront ' +
              'cost — quote 5 unless the task clearly needs more.',
            minimum: 1,
            maximum: 60,
          },
        },
        required: ['estimatedMinutes'],
      },
      method: 'POST',
      path: '/browser/session/create',
    },
  ],
};
