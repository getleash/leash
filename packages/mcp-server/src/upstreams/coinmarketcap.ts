import type { McpUpstreamAdapter } from './types.js';

// ─── CoinMarketCap x402 MCP ──────────────────────────────────────────
//
// The flagship MVP upstream. Full findings + wire captures live in
// poc/b-x402-proxy/findings.md. Every non-default field here is
// load-bearing — tweak only after re-verifying against live CMC.

export const coinmarketcapAdapter: McpUpstreamAdapter = {
  name: 'coinmarketcap',
  transport: 'mcp',
  x402Version: 2,
  challengeLocation: 'header',
  usdcDomainSource: 'challenge-extra',
};
