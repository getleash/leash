// @getleash/mcp-server — public surface
//
// The MCP server runtime the Cryptonit agent talks to via stdio.
// Ships: SQLite-backed policy counters, session-key unseal, real
// transfer / revoke_session_key handlers, curated upstream adapters
// + x402 middleware, pay_for_api (explicit signing), and republished
// upstream tools under their namespace prefix.

export { createLeashMcpServer, serveStdio } from './server.js';
export type {
  CreateServerParams,
  LeashMcpServerHandle,
  ServeStdioParams,
} from './server.js';

export { AgentConfigError, loadAgentRuntime } from './agent-config.js';
export type {
  AgentRuntime,
  LeashAgentRecord,
  LeashHubConfig,
  LoadAgentRuntimeParams,
} from './agent-config.js';

export {
  buildMcpError,
  configMissing,
  notYetImplemented,
  sessionKeyExpired,
} from './errors.js';
export type { BuildMcpErrorParams } from './errors.js';

export { PaymentLog, startOfWindow } from './db.js';
export type {
  ConfirmPaymentParams,
  FailPaymentParams,
  InsertPaymentParams,
  PaymentKind,
  PaymentRow,
  PaymentStatus,
  SpendWindow,
} from './db.js';

export { checkPolicy, windowResetsAtMs } from './policy.js';
export type { PolicyCheckParams, PolicyTarget } from './policy.js';

export {
  FileSessionKeyStore,
  SessionKeyStoreError,
} from './session-key.js';
export type { SessionKeyStore, FileStoreOptions } from './session-key.js';

// ─── Upstream adapters ───────────────────────────────────────────────
export { coinmarketcapAdapter } from './upstreams/coinmarketcap.js';
export { getUpstreamAdapter, supportedUpstreamNames } from './upstreams/registry.js';
export type { UpstreamAdapter } from './upstreams/types.js';

// ─── Proxy layer ─────────────────────────────────────────────────────
export {
  McpHttpClient,
  UpstreamMcpError,
} from './proxy/mcp-client.js';
export type { McpToolDescriptor, RawRpcResponse, UpstreamClient } from './proxy/mcp-client.js';
export { RestHttpClient } from './proxy/rest-client.js';
export { PaidToolCaller } from './proxy/paid-caller.js';
export type { PaidCallerDeps } from './proxy/paid-caller.js';
export { signX402Payment } from './proxy/pay.js';
export type { SignX402PaymentParams, SignedX402Payment } from './proxy/pay.js';
export {
  openUpstreamSessions,
  UpstreamInitError,
} from './proxy/upstream-session.js';
export type { UpstreamSession } from './proxy/upstream-session.js';

export { registerLeashTools } from './tools/index.js';
export type { ToolContext } from './tools/types.js';
