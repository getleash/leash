import type { HttpRestUpstreamAdapter } from './types.js';

// ─── x402factory.ai (LLM via GPT wrapper) ────────────────────────────
//
// Probed live 2026-05-12 against x402factory.ai/base/llm/gpt.
// payTo 0x402FaCcC3fAeb72351CC2b68C7966faF5f22B0d4, x402 v1 (body challenge).
//
// Default call: model=gpt-5-mini, max_output_tokens=2000, cost $0.01 for up
// to 1000 input tokens. Custom-priced for longer prompts (see upstream docs).
//
// Fills the catalog's AI-inference category at a clean per-call price.

export const x402factoryAdapter: HttpRestUpstreamAdapter = {
  name: 'x402factory',
  transport: 'http-rest',
  x402Version: 1,
  challengeLocation: 'body',
  usdcDomainSource: 'challenge-extra',
  baseUrl: 'https://x402factory.ai',
  tools: [
    {
      name: 'gpt_completion',
      description:
        'Send a prompt to GPT (default: gpt-5-mini, max_output_tokens=2000). ' +
        '$0.01 per default call. For larger prompts, x402factory computes a ' +
        'per-model price; the on-chain witness validator enforces the policy cap.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The user prompt.' },
          model: {
            type: 'string',
            description: 'OpenAI-compatible model name (default: gpt-5-mini).',
          },
          max_output_tokens: {
            type: 'number',
            description: 'Token cap on the response (default 2000).',
          },
        },
        required: ['message'],
      },
      method: 'POST',
      path: '/base/llm/gpt',
    },
  ],
};
