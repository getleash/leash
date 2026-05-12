import type { HttpRestUpstreamAdapter } from './types.js';

// ─── Agoragentic x402 (document + content tools) ─────────────────────
//
// Probed live 2026-05-12 against x402.agoragentic.com/v1/text-summarizer.
// payTo 0xadB33740…70BC, $0.10/call across the surface, x402 v2 (body).
//
// Four sibling tools (catalog promised, paths confirmed in the 402's
// `resource` field). All four share the same payTo + price + protocol.

export const agoragenticAdapter: HttpRestUpstreamAdapter = {
  name: 'agoragentic',
  transport: 'http-rest',
  x402Version: 2,
  challengeLocation: 'body',
  usdcDomainSource: 'challenge-extra',
  baseUrl: 'https://x402.agoragentic.com',
  tools: [
    {
      name: 'text_summarizer',
      description:
        'Summarize a block of text into N sentences. $0.10 / call.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The text to summarize.' },
          max_sentences: { type: 'number', description: 'Target summary length (default upstream-defined).' },
        },
        required: ['text'],
      },
      method: 'POST',
      path: '/v1/text-summarizer',
    },
    {
      name: 'web_scraper',
      description:
        'Fetch and structure the readable content of a URL. $0.10 / call. ' +
        'Complementary to a generic scraper — Agoragentic post-processes for ' +
        'agent consumption (cleaner markdown, fewer footers).',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to scrape.' },
        },
        required: ['url'],
      },
      method: 'POST',
      path: '/v1/web-scraper',
    },
    {
      name: 'receipt_reconciliation',
      description:
        'Parse a receipt image/text into structured line items. $0.10 / call.',
      inputSchema: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'OCR text or base64-encoded receipt image.' },
        },
        required: ['input'],
      },
      method: 'POST',
      path: '/v1/receipt-reconciliation',
    },
    {
      name: 'agent_discovery_audit',
      description:
        "Audit an agent's discovery / introspection surface for over-exposure. $0.10 / call.",
      inputSchema: {
        type: 'object',
        properties: {
          manifest: { type: 'object' },
        },
        required: ['manifest'],
      },
      method: 'POST',
      path: '/v1/agent-discovery-audit',
    },
  ],
};
