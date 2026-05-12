import type { HttpRestUpstreamAdapter } from './types.js';

// ─── Exa x402 (AI-powered web search) ────────────────────────────────
//
// Probed live 2026-05-12 against api.exa.ai/search.
// payTo 0x6d6E695b…9192, $0.007/call, x402 v2 (header challenge —
// the 402 response uses the `payment-required` header with a base64-
// encoded JSON challenge, not a body).
//
// Exa has two surfaces:
//   - /search: keyword + neural search over the indexed web ($0.007)
//   - /contents: paid content retrieval for a URL list ($0.001)

export const exaAdapter: HttpRestUpstreamAdapter = {
  name: 'exa',
  transport: 'http-rest',
  x402Version: 2,
  challengeLocation: 'header',
  usdcDomainSource: 'challenge-extra',
  baseUrl: 'https://api.exa.ai',
  tools: [
    {
      name: 'search',
      description:
        "Neural + keyword web search via Exa. Returns ranked results with " +
        'titles, URLs, scores, and optional content snippets. $0.007 / call. ' +
        'Use this when you need fresh, broad web search beyond what a ' +
        'crawler can give you.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query.' },
          numResults: { type: 'number', description: 'How many results (default upstream-defined).' },
          type: {
            type: 'string',
            enum: ['keyword', 'neural', 'auto'],
            description: 'Search algorithm. "neural" for semantic, "keyword" for exact match, "auto" lets Exa pick.',
          },
        },
        required: ['query'],
      },
      method: 'POST',
      path: '/search',
    },
    {
      name: 'get_contents',
      description:
        'Retrieve full text / summaries / highlights for a list of URLs ' +
        '(usually returned by `search`). $0.001 / call.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of Exa-issued URL/result IDs (from `search` responses) or raw URLs.',
          },
        },
        required: ['ids'],
      },
      method: 'POST',
      path: '/contents',
    },
  ],
};
