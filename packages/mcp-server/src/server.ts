import { resolve } from 'node:path';
import {
  type Chain,
  type WalletClient,
  createWalletClient,
  http,
} from 'viem';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  loadAgentRuntime,
  type AgentRuntime,
  type LoadAgentRuntimeParams,
} from './agent-config.js';
import { createLeashPublicClient, resolveRpcUrl } from './blockchain.js';
import { PaymentLog } from './db.js';
import { FileSessionKeyStore, type SessionKeyStore } from './session-key.js';
import { registerLeashTools } from './tools/index.js';
import type { ToolContext } from './tools/types.js';
import { openUpstreamSessions, type UpstreamSession } from './proxy/upstream-session.js';

// ─── Server factory ──────────────────────────────────────────────────
//
// Builds the McpServer + registers all own tools + republishes every
// upstream tool under its namespace prefix. Transport binding happens
// in the caller — `serveStdio` is the production path; tests use
// `createLeashMcpServer` + an in-process transport.
//
// Upstream initialization is ASYNC (Phase 6c). `createLeashMcpServer`
// stays synchronous for backward-compat; callers that want upstreams
// pass in pre-opened sessions, or use the higher-level
// `createLeashMcpServerWithUpstreams` helper.

export interface CreateServerParams {
  runtime: AgentRuntime;
  publicClient?: ToolContext['publicClient'];
  dbPath?: string;
  sessionKeys?: SessionKeyStore;
  bundlerWallet?: WalletClient;
  noBundlerWallet?: boolean;
  /** Pre-opened upstream sessions (callers that want their own lifecycle). */
  upstreams?: UpstreamSession[];
}

export interface LeashMcpServerHandle {
  server: McpServer;
  ctx: ToolContext;
  close(): void;
}

export function createLeashMcpServer(
  params: CreateServerParams,
): LeashMcpServerHandle {
  const publicClient =
    params.publicClient ??
    createLeashPublicClient({ chainConfig: params.runtime.chainConfig });

  const dbPath =
    params.dbPath ??
    resolve(params.runtime.leashRoot, 'agent', params.runtime.agentName, 'leash.db');
  const db = new PaymentLog(dbPath);

  const sessionKeys =
    params.sessionKeys ??
    new FileSessionKeyStore({ leashRoot: params.runtime.leashRoot });

  let bundlerWallet: WalletClient | undefined = params.bundlerWallet;
  if (!bundlerWallet && !params.noBundlerWallet) {
    const hubOwner = sessionKeys.loadHubOwnerKey();
    bundlerWallet = createWalletClient({
      chain: params.runtime.chainConfig.chain as Chain,
      transport: http(resolveRpcUrl(params.runtime.chainConfig)),
      account: hubOwner,
    });
  }

  const ctx: ToolContext = {
    runtime: params.runtime,
    publicClient,
    db,
    sessionKeys,
    bundlerWallet,
    upstreams: params.upstreams ?? [],
  };

  const server = new McpServer(
    {
      name: '@getleash/mcp-server',
      version: '0.1.0',
    },
    {
      capabilities: { tools: {} },
      instructions: buildInstructions(params.runtime, ctx.upstreams),
    },
  );

  registerLeashTools(server, ctx);

  return {
    server,
    ctx,
    close() {
      db.close();
    },
  };
}

// ─── stdio entrypoint ────────────────────────────────────────────────

export interface ServeStdioParams extends LoadAgentRuntimeParams {
  publicClient?: ToolContext['publicClient'];
  dbPath?: string;
  /** Skip upstream initialization (dev / offline). Default: connect on startup. */
  noUpstreams?: boolean;
  /**
   * Override the key store. The CLI injects a Keychain-backed store
   * on macOS; the default without an override is the FileSessionKeyStore
   * built from `.leash/agent/<name>/session-key.json`.
   */
  sessionKeys?: SessionKeyStore;
}

/**
 * Production entrypoint. Called by `leash serve <agent>` which is
 * launched as an MCP subprocess by Claude Code via .mcp.json.
 *
 * Upstream MCP sessions are opened + tools/list'd before the stdio
 * server accepts its first request — a server that can't talk to its
 * upstreams shouldn't pretend to by announcing republished tools
 * that would all fail.
 */
export async function serveStdio(
  params: ServeStdioParams,
): Promise<LeashMcpServerHandle> {
  const runtime = loadAgentRuntime(params);

  const upstreams = params.noUpstreams
    ? []
    : await openUpstreamSessions(runtime);

  const handle = createLeashMcpServer({
    runtime,
    publicClient: params.publicClient,
    dbPath: params.dbPath,
    sessionKeys: params.sessionKeys,
    upstreams,
  });
  const transport = new StdioServerTransport();
  await handle.server.connect(transport);
  return handle;
}

// ─── helpers ─────────────────────────────────────────────────────────

function buildInstructions(
  runtime: AgentRuntime,
  upstreams: UpstreamSession[],
): string {
  const base =
    `Leash MCP — agent '${runtime.agentName}' on ${runtime.chainConfig.name}. ` +
    `Sub-account ${runtime.agent.subAccount}. ` +
    `Call get_api_budget before spending. ` +
    `Errors are structured (structuredContent.code); respect suggested_action.`;
  if (upstreams.length === 0) return base;
  const namespaces = upstreams.map((u) => u.namespace).join(', ');
  return (
    base +
    ` Republished upstream tools are prefixed: ${namespaces}. ` +
    `Payments on 402 are handled automatically.`
  );
}
