import type { HttpRestUpstreamAdapter } from './types.js';

// ─── Gloria AI x402 (real-time news) ─────────────────────────────────
//
// Probed live 2026-05-12 against api.itsgloria.ai/news.
// payTo 0xCa1271E7…cd0c, $0.03/call (top of crypto-news tier).
// Fixture: tests/fixtures/upstream-probes/gloria.json.
//
// Catalog also lists /recaps and /news-by-keyword — surfaced as
// separate tools so the agent can pick the right query shape.

export const gloriaAdapter: HttpRestUpstreamAdapter = {
  name: 'gloria',
  transport: 'http-rest',
  // x402 v1 (`X-PAYMENT` retry header) — confirmed live 2026-05-12.
  x402Version: 1,
  challengeLocation: 'body',
  usdcDomainSource: 'challenge-extra',
  baseUrl: 'https://api.itsgloria.ai',
  tools: [
    {
      name: 'get_news',
      description:
        "Fetch the latest real-time crypto + macro news headlines curated " +
        "by Gloria AI. $0.03 / call. Use this for 'what's happening right " +
        "now' style queries; use search_news_by_keyword if you want a " +
        'targeted topic.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of items to return (default upstream-defined).' },
        },
      },
      method: 'GET',
      path: '/news',
    },
    {
      name: 'search_news_by_keyword',
      description:
        "Search Gloria's news index for a specific keyword or phrase. " +
        'Returns matching headlines with timestamps. $0.03 / call.',
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Keyword or phrase to search for.' },
          limit: { type: 'number' },
        },
        required: ['q'],
      },
      method: 'GET',
      path: '/news-by-keyword',
    },
  ],
};
