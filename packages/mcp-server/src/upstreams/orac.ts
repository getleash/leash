import type { HttpRestUpstreamAdapter } from './types.js';

// ─── Orac Safety Layer x402 (prompt-injection + skill audit) ─────────
//
// Probed live 2026-05-12 against orac-safety.orac.workers.dev/v1/scan.
// payTo 0x4a47B25c…7ca5, x402 v2 (body challenge).
//
// Two tools:
//   - scan: quick prompt-injection check on a single text ($0.05)
//   - audit: deeper skill / capability audit on an agent definition ($0.10)
//
// Useful for the "agent-of-agents" story where Leash sits in front of an
// agent that delegates to other agents.

export const oracAdapter: HttpRestUpstreamAdapter = {
  name: 'orac',
  transport: 'http-rest',
  x402Version: 2,
  challengeLocation: 'body',
  usdcDomainSource: 'challenge-extra',
  baseUrl: 'https://orac-safety.orac.workers.dev',
  tools: [
    {
      name: 'scan',
      description:
        'Scan a text snippet for prompt-injection patterns. Returns a ' +
        'risk score + flagged segments. $0.05 / call. Useful before ' +
        'forwarding user input to a downstream LLM.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The text to scan.' },
        },
        required: ['text'],
      },
      method: 'POST',
      path: '/v1/scan',
    },
    {
      name: 'audit',
      description:
        'Audit an agent definition (system prompt + tool list) for ' +
        'capability creep, escalation risks, and unsafe tool exposure. ' +
        '$0.10 / call.',
      inputSchema: {
        type: 'object',
        properties: {
          system_prompt: { type: 'string' },
          tools: { type: 'array', items: { type: 'object' } },
        },
        required: ['system_prompt'],
      },
      method: 'POST',
      path: '/v1/audit',
    },
  ],
};
