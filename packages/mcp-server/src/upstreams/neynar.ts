import type { HttpRestUpstreamAdapter } from './types.js';

// ─── Neynar x402 (Farcaster social) ──────────────────────────────────
//
// Probed live 2026-05-12 against api.neynar.com/v2/farcaster/user/bulk.
// payTo 0xA6a8736f…01A1, $0.01/call, x402 v2 (body challenge).
// Fixture: tests/fixtures/upstream-probes/neynar.json.
//
// Neynar's REST API surface is broad (dozens of endpoints across users,
// casts, feeds, channels, signers). MVP exposes the bulk-user lookup as
// the canonical "I want to learn about a Farcaster user" call. Future
// adapter passes can add more endpoints — each is one entry in `tools`.

export const neynarAdapter: HttpRestUpstreamAdapter = {
  name: 'neynar',
  transport: 'http-rest',
  // x402 v1 (`X-PAYMENT` retry header) — confirmed live 2026-05-12.
  x402Version: 1,
  challengeLocation: 'body',
  usdcDomainSource: 'challenge-extra',
  baseUrl: 'https://api.neynar.com',
  tools: [
    {
      name: 'get_users',
      description:
        'Fetch one or more Farcaster users by FID (Farcaster ID) or wallet ' +
        'address. Returns the canonical user profile, custody/verified ' +
        'addresses, follower counts, and recent activity hints. $0.01 / call.',
      inputSchema: {
        type: 'object',
        properties: {
          fids: {
            type: 'string',
            description: 'Comma-separated list of Farcaster IDs (e.g. "3,194,2"). At least one is required.',
          },
        },
        required: ['fids'],
      },
      method: 'GET',
      path: '/v2/farcaster/user/bulk',
    },
  ],
};
