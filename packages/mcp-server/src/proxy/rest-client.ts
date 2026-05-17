import type { HttpRestUpstreamAdapter, RestToolSpec } from '../upstreams/types.js';
import type { McpToolDescriptor, RawRpcResponse, UpstreamClient } from './mcp-client.js';

// ─── Minimal REST→MCP synthesis client ───────────────────────────────
//
// Sits behind the same `UpstreamClient` interface as the MCP-native
// client (`mcp-client.ts`), so the 402 retry loop in PaidToolCaller is
// transport-agnostic. For each REST adapter the proxy synthesizes
// `tools/list` from the adapter's declared `tools[]` array, and every
// `tools/call` becomes one HTTP request to `<baseUrl><path>` with
// args mapped to path params, JSON body, or query string per the
// tool's `bodyMode`.
//
// What this client does NOT do:
//   - response unwrapping (the agent gets whatever the upstream sends)
//   - retry logic (PaidToolCaller owns the 402 → sign → retry loop)
//   - schema validation of args (upstreams validate; we pass through)
//
// The x402 flow is identical regardless of transport: 402 status +
// challenge (in `Payment-Required` header or response body) → parse →
// sign → retry with `Payment-Signature` (v2) / `X-PAYMENT` (v1) header.

export class RestHttpClient implements UpstreamClient {
  constructor(private readonly adapter: HttpRestUpstreamAdapter) {}

  async initialize(): Promise<void> {
    // REST adapters declare their tools statically; no server-side
    // handshake to do. Kept for the UpstreamClient contract.
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    return this.adapter.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): Promise<RawRpcResponse> {
    const tool = this.adapter.tools.find((t) => t.name === name);
    if (!tool) {
      throw new Error(
        `RestHttpClient.callTool: unknown tool "${name}" on adapter "${this.adapter.name}"`,
      );
    }
    const { url, init } = buildRequest(this.adapter.baseUrl, tool, args, extraHeaders);
    // TEMP DEBUG (remove before commit): log to a file so we can capture
    // request/response shape across the spawned leash subprocess (stderr
    // is swallowed by the MCP transport under `claude --print`).
    const debugPath = process.env.LEASH_DEBUG_REST;
    if (debugPath) {
      const isRetry = !!extraHeaders && Object.keys(extraHeaders).length > 0;
      const fs = await import('node:fs/promises');
      await fs.appendFile(
        debugPath,
        `${new Date().toISOString()} [${isRetry ? 'RETRY' : 'PROBE'}] ${init.method} ${url}\n` +
          `  args=${JSON.stringify(args)}\n` +
          `  body=${typeof init.body === 'string' ? init.body : String(init.body)}\n` +
          `  headers=${JSON.stringify(Object.keys(init.headers ?? {}))}\n`,
      );
    }
    const res = await fetch(url, init);
    const bodyText = await res.text();
    if (debugPath) {
      const fs = await import('node:fs/promises');
      await fs.appendFile(
        debugPath,
        `  ↳ ${res.status} | body[:300]=${bodyText.slice(0, 300)}\n\n`,
      );
    }
    return {
      status: res.status,
      headers: res.headers,
      bodyText,
      body: bodyText ? safeJson(bodyText) : null,
    };
  }
}

// ─── Request construction ────────────────────────────────────────────

/**
 * Build the URL + RequestInit for one tool call. Args flow in three
 * places:
 *   1. Path params: any `{key}` in `tool.path` consumes `args.key`.
 *   2. Body or query (per `tool.bodyMode`): whatever remains after (1).
 *
 * Default `bodyMode`:
 *   - GET: 'query' (URL search params)
 *   - POST: 'json' (JSON request body)
 */
function buildRequest(
  baseUrl: string,
  tool: RestToolSpec,
  args: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): { url: string; init: RequestInit } {
  const { path, remaining } = substitutePathParams(tool.path, args);
  const mode = tool.bodyMode ?? (tool.method === 'GET' ? 'query' : 'json');

  let url = trimTrailingSlash(baseUrl) + path;
  let body: BodyInit | undefined;
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(tool.headers ?? {}),
    ...(extraHeaders ?? {}),
  };

  if (mode === 'query') {
    const qs = toQueryString(remaining);
    if (qs) url = url + (url.includes('?') ? '&' : '?') + qs;
  } else if (mode === 'json') {
    if (tool.method === 'GET') {
      throw new Error(
        `RestHttpClient: tool "${tool.name}" specifies bodyMode='json' with method='GET' — pick bodyMode='query' or 'none'`,
      );
    }
    headers['content-type'] = headers['content-type'] ?? 'application/json';
    body = JSON.stringify(remaining);
  }
  // mode === 'none': drop remaining args.

  return { url, init: { method: tool.method, headers, body } };
}

function substitutePathParams(
  path: string,
  args: Record<string, unknown>,
): { path: string; remaining: Record<string, unknown> } {
  let out = path;
  const remaining: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(args)) {
    const placeholder = `{${key}}`;
    if (out.includes(placeholder)) {
      out = out.replaceAll(placeholder, encodeURIComponent(String(value)));
      delete remaining[key];
    }
  }
  return { path: out, remaining };
}

function toQueryString(args: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    params.append(k, String(v));
  }
  return params.toString();
}

function trimTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
