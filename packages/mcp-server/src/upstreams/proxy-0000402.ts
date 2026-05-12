import type { HttpRestUpstreamAdapter } from './types.js';

// ─── proxy.0000402.xyz (HTTP proxy) ──────────────────────────────────
//
// Verified live 2026-05-12. v2 (body challenge). $0.01/call.
// payTo 0xeE72B902…77c (shared with the 0000402.xyz operator family —
// donate, tempfile, pastebin, timecapsule, human, cron, play).
//
// Use case: agent needs to fetch a URL but can't (geo, CORS, etc.).
// Send {url, method, headers, body} → proxy forwards and returns the response.

export const proxy0000402Adapter: HttpRestUpstreamAdapter = {
  name: 'proxy-0000402',
  transport: 'http-rest',
  x402Version: 2,
  challengeLocation: 'body',
  usdcDomainSource: 'challenge-extra',
  baseUrl: 'https://proxy.0000402.xyz',
  tools: [
    {
      name: 'fetch',
      description:
        'Make an outbound HTTP request through the 0000402 proxy. Supports any ' +
        'HTTP method, custom headers, and JSON or raw bodies. Responses returned ' +
        'as text or base64-encoded binary. Max response size 10 MB, timeout 30s. $0.01/call.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Target URL.' },
          method: { type: 'string', description: 'HTTP method (GET/POST/etc.). Default: GET.' },
          headers: { type: 'object', description: 'Optional request headers.' },
          body: { type: 'string', description: 'Optional request body (string or base64-encoded).' },
        },
        required: ['url'],
      },
      method: 'POST',
      path: '/fetch',
    },
  ],
};
