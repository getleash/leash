import type { HttpRestUpstreamAdapter } from './types.js';

// ─── tempfile.0000402.xyz (file storage, 7-day TTL) ──────────────────
//
// Verified live 2026-05-12. v2 (body challenge). $0.02/call.
// payTo 0xeE72B902…77c (shared with 0000402.xyz operator family).

export const tempfile0000402Adapter: HttpRestUpstreamAdapter = {
  name: 'tempfile-0000402',
  transport: 'http-rest',
  x402Version: 2,
  challengeLocation: 'body',
  usdcDomainSource: 'challenge-extra',
  baseUrl: 'https://tempfile.0000402.xyz',
  tools: [
    {
      name: 'upload',
      description:
        'Store a file (up to 10 MB) for 7 days. Returns a token + stable GET URL. ' +
        'Send filename, optional content_type, and base64-encoded bytes as JSON. $0.02/call.',
      inputSchema: {
        type: 'object',
        properties: {
          filename: { type: 'string' },
          content_type: { type: 'string', description: 'MIME type (optional).' },
          content_base64: { type: 'string', description: 'Base64-encoded file bytes.' },
        },
        required: ['filename', 'content_base64'],
      },
      method: 'POST',
      path: '/upload',
    },
  ],
};
