import type { PublicClient, WalletClient } from 'viem';
import type { AgentRuntime } from '../agent-config.js';
import type { PaymentLog } from '../db.js';
import type { SessionKeyStore } from '../session-key.js';
import type { UpstreamSession } from '../proxy/upstream-session.js';

// ─── Tool handler context ────────────────────────────────────────────
//
// Every tool gets the same context. Phase 6c added `upstreams` —
// the set of live MCP sessions the proxy layer uses to forward
// republished tool calls.

export interface ToolContext {
  runtime: AgentRuntime;
  publicClient: PublicClient;
  db: PaymentLog;
  sessionKeys: SessionKeyStore;
  bundlerWallet?: WalletClient;
  /** Open upstream sessions. Empty if none declared or `noUpstreams: true` was passed. */
  upstreams: UpstreamSession[];
}
