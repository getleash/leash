import type { AgentRuntime } from '../agent-config.js';
import type { UpstreamAdapter } from '../upstreams/types.js';
import { getUpstreamAdapter, supportedUpstreamNames } from '../upstreams/registry.js';
import { McpHttpClient, type McpToolDescriptor, type UpstreamClient } from './mcp-client.js';
import { RestHttpClient } from './rest-client.js';

// ─── Upstream session ────────────────────────────────────────────────
//
// One per upstream declared in the policy. On startup the server
// either runs the MCP handshake (for `transport: 'mcp'` adapters like
// CMC) or synthesizes the tool list from the adapter's declared
// `tools[]` array (for `transport: 'http-rest'` adapters — the majority
// of the Phase D catalog). Either way, each tool is then republished
// with a `<namespace>__<tool>` prefix on the Leash MCP surface. The
// 402 retry loop in `paid-caller.ts` is transport-agnostic — both
// client types share the `UpstreamClient` interface.

export interface UpstreamSession {
  /** Policy-declared name (e.g. "coinmarketcap"). */
  name: string;
  /** Policy-declared namespace prefix for republished tools. */
  namespace: string;
  adapter: UpstreamAdapter;
  /** Transport-agnostic client (MCP or REST synthesizer). */
  client: UpstreamClient;
  /** Tools fetched via tools/list (MCP) or synthesized from adapter.tools (REST). */
  tools: McpToolDescriptor[];
}

export class UpstreamInitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamInitError';
  }
}

/**
 * Open one session per upstream declared in the agent's grant. Throws
 * on any failure — a server that can't talk to its upstreams is not
 * functional, so fail loudly at startup instead of quietly at first
 * tool call.
 *
 * `policyUpstream.url` is honored only for MCP adapters (the MCP server
 * endpoint). REST adapters use their static `baseUrl` declared in the
 * adapter file — the policy's `url` field is informational for those.
 */
export async function openUpstreamSessions(
  runtime: AgentRuntime,
): Promise<UpstreamSession[]> {
  const sessions: UpstreamSession[] = [];
  for (const u of runtime.signedGrant.grant.upstreams) {
    const adapter = getUpstreamAdapter(u.name);
    if (!adapter) {
      throw new UpstreamInitError(
        `upstream "${u.name}" has no adapter on this build. ` +
          `Supported: ${supportedUpstreamNames().join(', ')}`,
      );
    }
    const client: UpstreamClient =
      adapter.transport === 'mcp'
        ? new McpHttpClient(u.url)
        : new RestHttpClient(adapter);
    try {
      await client.initialize();
      const tools = await client.listTools();
      sessions.push({
        name: u.name,
        namespace: u.namespace,
        adapter,
        client,
        tools,
      });
    } catch (e) {
      throw new UpstreamInitError(
        `upstream "${u.name}" at ${u.url}: ${(e as Error).message}`,
      );
    }
  }
  return sessions;
}
