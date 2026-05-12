// ─── Upstream adapter interface ──────────────────────────────────────
//
// Each curated upstream ships a small adapter declaring its quirks.
// The proxy uses these to drive @getleash/core's x402 parser + payload
// builder correctly for that upstream. See summary/architecture.md
// §"MCP proxy / addon model — curated upstream adapters" for why the
// MVP is curated-only (PoC-B hit three real incompatibilities against
// CMC alone; a "works-with-any-URL" claim costs more than it earns).
//
// Two transport modes (Phase D / 2026-05-12):
//   - `mcp`:       upstream ships a real MCP server. The proxy opens
//                  a session, calls `tools/list` at startup, and
//                  republishes every tool. CoinMarketCap is the
//                  reference MCP-mode upstream.
//   - `http-rest`: upstream is a plain REST API. The adapter declares
//                  a tool list (name, schema, method, path) which Leash
//                  synthesizes as MCP `tools/list` entries; each
//                  `tools/call` becomes one HTTP request. Most of the
//                  Phase D 10-upstream catalog is REST.

import type { Address } from 'viem';

export interface BaseUpstreamAdapter {
  /** Name used in the policy markdown's `## Upstreams` list. */
  name: string;

  /** x402 protocol version this upstream speaks. */
  x402Version: 1 | 2;

  /**
   * Where the 402 challenge arrives.
   * CMC ships v2 via the `Payment-Required` HTTP response header;
   * other implementations deliver in the body.
   */
  challengeLocation: 'body' | 'header';

  /**
   * Source of the USDC EIP-712 domain {name, version} for the inner
   * TransferWithAuthorization signature.
   * - 'challenge-extra': read `accept.extra.{name,version}` from the
   *   challenge (CMC; safest because the upstream declares what it
   *   expects the facilitator to submit).
   * - 'hardcoded': fall back to ChainConfig.usdcDomainName/Version.
   */
  usdcDomainSource: 'challenge-extra' | 'hardcoded';
}

/** Adapter for an upstream that ships a real MCP server. */
export interface McpUpstreamAdapter extends BaseUpstreamAdapter {
  transport: 'mcp';
}

/**
 * Adapter for a REST upstream. Declares the tool list Leash synthesizes
 * for the agent; each tool call becomes an HTTP request with optional
 * path templating, body shaping, and forced x402 headers.
 */
export interface HttpRestUpstreamAdapter extends BaseUpstreamAdapter {
  transport: 'http-rest';
  /** Base URL the adapter's tool paths attach to. */
  baseUrl: string;
  /** Tool list synthesized as MCP `tools/list` entries. */
  tools: RestToolSpec[];
}

export type UpstreamAdapter = McpUpstreamAdapter | HttpRestUpstreamAdapter;

export interface RestToolSpec {
  /** Tool name (will be prefixed with the adapter's namespace by the proxy). */
  name: string;
  /** Description surfaced to the agent. */
  description: string;
  /**
   * JSON Schema for tool inputs. Passed verbatim to the agent.
   * Mirror the upstream's documented schema so the agent knows what to send.
   */
  inputSchema: Record<string, unknown>;
  /** HTTP method. */
  method: 'GET' | 'POST';
  /**
   * Path appended to the adapter's `baseUrl`. May contain `{param}`
   * placeholders that get substituted from the call's args before the
   * request is sent (e.g. `path: '/api/users/{userId}'` + `args: { userId: '42' }`
   * produces `/api/users/42`). Path-substituted params are removed from
   * the body / query string.
   */
  path: string;
  /**
   * How remaining args (after path substitution) are encoded.
   * - `'json'` (default): args become a JSON request body. POST only.
   * - `'query'`: args become URL query parameters. Works with GET or POST.
   * - `'none'`: ignore remaining args. Useful for tools whose only inputs
   *   are path params.
   */
  bodyMode?: 'json' | 'query' | 'none';
  /**
   * Extra headers to send with the request. Use this to force x402 mode
   * on dual-mode endpoints (e.g. `{ 'Accept': 'application/x402+json' }`)
   * or to set content-type explicitly.
   */
  headers?: Record<string, string>;
}

// Re-exported for adapters that want to type their static payTo at the
// source rather than relying on @getleash/core's registry. Optional; the
// canonical payTo registry is `packages/core/src/upstream-payto.ts`.
export type UpstreamPayTo = Address;
