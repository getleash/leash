import type { HttpRestUpstreamAdapter } from './types.js';

// ─── pastebin.0000402.xyz (encrypted paste) ──────────────────────────
//
// Verified live 2026-05-12. v2 (body challenge). $0.01/call.
// payTo 0xeE72B902…77c (shared with 0000402.xyz operator family).
//
// Encrypted with AES-256-GCM; key derived from passphrase via scrypt.
// The passphrase is never stored — only the ciphertext. Reveal with
// POST /secret/{token} and the correct passphrase.

export const pastebin0000402Adapter: HttpRestUpstreamAdapter = {
  name: 'pastebin-0000402',
  transport: 'http-rest',
  x402Version: 2,
  challengeLocation: 'body',
  usdcDomainSource: 'challenge-extra',
  baseUrl: 'https://pastebin.0000402.xyz',
  tools: [
    {
      name: 'paste',
      description:
        'Store an encrypted secret (up to 100 KB). Returns a token; recipient ' +
        'reveals via POST /secret/{token} + the correct passphrase. Useful for ' +
        'agent-to-agent secret exchange or one-time credential handoff. $0.01/call.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Plaintext secret to encrypt.' },
          passphrase: { type: 'string', description: 'Passphrase used to derive the encryption key.' },
        },
        required: ['content', 'passphrase'],
      },
      method: 'POST',
      path: '/paste',
    },
  ],
};
