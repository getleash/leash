import type { MCPError, MCPErrorCategory, MCPErrorCode } from '@getleash/core';

// ─── MCP error envelope ──────────────────────────────────────────────
//
// Every tool-visible failure goes through this builder. Canonical
// strings live in summary/errors.md §1; the walking-skeleton goldens
// pin them. The parameters intentionally match the six fields of the
// structured envelope so a mismatch shows up as a TS error, not a
// runtime surprise.

export interface BuildMcpErrorParams {
  code: MCPErrorCode;
  category: MCPErrorCategory;
  /** Human-readable, action-oriented — what Claude relays to John. */
  text: string;
  /** Code-specific detail shape (pinned per-code in api-design.md). */
  details: Record<string, unknown>;
  /** One-line command or instruction. Never empty. */
  suggested_action: string;
}

export function buildMcpError(p: BuildMcpErrorParams): MCPError {
  if (!p.suggested_action) {
    // Enforced in summary/errors.md §4 "No silent degradation".
    throw new Error(
      `buildMcpError: suggested_action is mandatory (code=${p.code})`,
    );
  }
  return {
    isError: true,
    content: [{ type: 'text', text: p.text }],
    structuredContent: {
      code: p.code,
      category: p.category,
      details: p.details,
      suggested_action: p.suggested_action,
    },
  };
}

// ─── Common ready-made errors ────────────────────────────────────────
//
// Keeping the factories typed at the call site stops the text drifting
// away from summary/errors.md.

export function configMissing(agentName: string): MCPError {
  return buildMcpError({
    code: 'CONFIG_MISSING',
    category: 'config',
    text:
      `Leash: no agent named '${agentName}' is registered on this machine. ` +
      `Run \`leash apply ${agentName}-policy.md\` to register, or run ` +
      `\`leash status\` to see what agents exist.`,
    details: { agent: agentName },
    suggested_action: `leash apply ${agentName}-policy.md  or  leash status`,
  });
}

export function sessionKeyExpired(agentName: string, expiredAt: string): MCPError {
  return buildMcpError({
    code: 'SESSION_KEY_EXPIRED',
    category: 'auth',
    text:
      `Leash: session key for ${agentName} expired at ${expiredAt} UTC. ` +
      `Ask the user to run \`leash apply ${agentName}-policy.md\` to renew.`,
    details: { agent: agentName, expired_at: expiredAt },
    suggested_action: `leash apply ${agentName}-policy.md`,
  });
}

// Sentinel for tools that are wired but not yet implemented. Marking
// them `config` keeps Claude from retrying (per summary/errors.md
// §"Category → Claude's behavior").
export function notYetImplemented(tool: string, landing: string): MCPError {
  return buildMcpError({
    code: 'CONFIG_MISSING',
    category: 'config',
    text:
      `Leash: tool '${tool}' is wired but not yet implemented on this ` +
      `build. Landing in ${landing}. Read-only tools (get_balance, ` +
      `get_api_budget) work; write tools do not.`,
    details: { tool, landing },
    suggested_action: `upgrade Leash once ${landing} ships`,
  });
}
