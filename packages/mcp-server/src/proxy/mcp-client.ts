// ─── Minimal Streamable-HTTP MCP client ──────────────────────────────
//
// Generalized from poc/b-x402-proxy/src/mcp.ts. We don't use the
// MCP SDK's Client here because the SDK abstracts the HTTP response
// headers, and the x402 hot path specifically needs the raw
// Payment-Required header + the 402 status code intercepted before
// it becomes an MCP-level error.
//
// Scope: JSON-RPC over HTTP POST, one session per instance. No SSE
// streaming in MVP (CMC's flow is request/response).

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface RawRpcResponse {
  status: number;
  headers: Headers;
  /** Raw UTF-8 body text (undecoded). */
  bodyText: string;
  /** Decoded JSON body, or null if the body was empty / non-JSON. */
  body: unknown;
}

/**
 * Shared transport interface used by `PaidToolCaller`. Both the
 * MCP-native client (`McpHttpClient`) and the REST-synthesizing client
 * (`RestHttpClient`) implement it, so the 402 retry loop is transport-
 * agnostic. `initialize` + `listTools` are setup-only; `callTool` is
 * the hot path where the x402 dance happens.
 */
export interface UpstreamClient {
  initialize(): Promise<void>;
  listTools(): Promise<McpToolDescriptor[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): Promise<RawRpcResponse>;
}

export class UpstreamMcpError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'UpstreamMcpError';
  }
}

export class McpHttpClient {
  private sessionId?: string;
  private nextId = 1;
  private initialized = false;

  constructor(private readonly url: string, private readonly clientName = '@getleash/mcp-server') {}

  /**
   * Perform the initialize + notifications/initialized handshake.
   * Safe to call once; subsequent calls are a no-op.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    const res = await this.rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: this.clientName, version: '0.1.0' },
    });
    if (res.status !== 200 || !isObject(res.body) || !('result' in res.body)) {
      throw new UpstreamMcpError(
        `upstream initialize failed (status ${res.status})`,
        res.status,
      );
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    await this.notify('notifications/initialized', {});
    this.initialized = true;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const res = await this.rpc('tools/list', {});
    const body = res.body as { result?: { tools?: McpToolDescriptor[] } } | null;
    const tools = body?.result?.tools;
    if (!Array.isArray(tools)) {
      throw new UpstreamMcpError(
        `upstream tools/list returned no tools (status ${res.status})`,
        res.status,
      );
    }
    return tools;
  }

  /**
   * Call a tool. Returns the raw response — 402s do NOT throw; the
   * caller (PaidToolCaller) inspects status + headers to drive the
   * x402 retry. `extraHeaders` carries the Payment-Signature /
   * X-PAYMENT header on the retry call.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): Promise<RawRpcResponse> {
    return this.rpc(
      'tools/call',
      { name, arguments: args },
      extraHeaders,
    );
  }

  // ─── transport ───────────────────────────────────────────────────

  private async rpc(
    method: string,
    params: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<RawRpcResponse> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...extraHeaders,
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    const body = { jsonrpc: '2.0', id: this.nextId++, method, params };
    const res = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const bodyText = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      bodyText,
      body: bodyText ? safeJson(bodyText) : null,
    };
  }

  private async notify(method: string, params: unknown): Promise<void> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
    });
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}
