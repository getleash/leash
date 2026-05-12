import type { HttpRestUpstreamAdapter } from './types.js';

// ─── Robtex x402 (DNS / IP / AS / Lightning intelligence) ────────────
//
// Probed live 2026-05-12 against x402.robtex.com/dns_lookup.
// payTo 0x5D62c697…6f5e, $0.005/call, **x402 v1** (Leash's first v1
// production upstream — v1 uses `X-PAYMENT` header on retry instead of
// v2's `Payment-Signature`).
//
// Robtex publishes 53 lookup endpoints across DNS, IP, AS, BGP, and
// Lightning Network categories. MVP exposes the canonical few; future
// passes can grow the tool list cheaply.
//
// Quirk: the first request returns 301 to a canonical `/en/<lookup>/<args>`
// form before serving 402. fetch() follows redirects by default on
// Node 18+, so no extra config needed in the REST client.

export const robtexAdapter: HttpRestUpstreamAdapter = {
  name: 'robtex',
  transport: 'http-rest',
  x402Version: 1,
  challengeLocation: 'body',
  usdcDomainSource: 'challenge-extra',
  baseUrl: 'https://x402.robtex.com',
  tools: [
    {
      name: 'dns_lookup',
      description:
        'DNS records for a hostname (A, AAAA, MX, NS, TXT, etc.). $0.005 / call.',
      inputSchema: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'Fully-qualified domain name.' },
        },
        required: ['host'],
      },
      method: 'GET',
      path: '/dns_lookup',
    },
    {
      name: 'ip_reputation',
      description:
        'Reputation + reverse-DNS + WHOIS metadata for an IP address. $0.005 / call.',
      inputSchema: {
        type: 'object',
        properties: {
          ip: { type: 'string', description: 'IPv4 or IPv6 address.' },
        },
        required: ['ip'],
      },
      method: 'GET',
      path: '/ip_reputation',
    },
  ],
};
