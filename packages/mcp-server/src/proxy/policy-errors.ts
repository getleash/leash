import type { MCPError } from '@getleash/core';
import { buildMcpError } from '../errors.js';

// ─── Policy denial → MCP error ───────────────────────────────────────
//
// Shared between the transfer tool and the x402 paid-caller — both
// run the same `checkPolicy` and need to emit the same structured
// errors with the strings pinned in summary/errors.md §1.

export function policyDenialToMcpError(
  code: string,
  details: Record<string, unknown>,
): MCPError {
  switch (code) {
    case 'SESSION_KEY_EXPIRED':
      return buildMcpError({
        code: 'SESSION_KEY_EXPIRED',
        category: 'auth',
        text: `Leash: session key expired at ${details.expired_at} UTC. Ask the user to run \`leash apply\` to renew.`,
        details,
        suggested_action: 'leash apply',
      });
    case 'RECIPIENT_NOT_ALLOWLISTED':
      return buildMcpError({
        code: 'RECIPIENT_NOT_ALLOWLISTED',
        category: 'auth',
        text: `Leash: recipient ${details.recipient} is not on the policy allowlist.`,
        details,
        suggested_action: 'run `leash apply` to refresh the allowlist',
      });
    case 'OVER_PER_TX_CAP':
      return buildMcpError({
        code: 'OVER_PER_TX_CAP',
        category: 'budget',
        text: `Leash: this call costs ${details.requested_usdc} USDC, which exceeds the per-transaction cap of ${details.cap_usdc} USDC set in the policy. Increase max_per_transaction and re-apply, or skip this call.`,
        details,
        suggested_action: 'edit policy.md → increase max_per_transaction, then `leash apply`',
      });
    case 'OVER_DAILY_CAP':
    case 'OVER_WEEKLY_CAP':
    case 'OVER_MONTHLY_CAP': {
      const windowName =
        code === 'OVER_DAILY_CAP' ? "today" : code === 'OVER_WEEKLY_CAP' ? 'this week' : 'this month';
      return buildMcpError({
        code: code as 'OVER_DAILY_CAP' | 'OVER_WEEKLY_CAP' | 'OVER_MONTHLY_CAP',
        category: 'budget',
        text: `Leash: ${windowName}'s budget of ${details.cap_usdc} USDC is spent. ${details.remaining_usdc} USDC remaining until ${details.resets_at} UTC.`,
        details,
        suggested_action: 'wait for reset or edit policy.md → increase the relevant limit',
      });
    }
    default:
      return buildMcpError({
        code: 'CONFIG_MISSING',
        category: 'config',
        text: `Leash: policy denied (code=${code}).`,
        details,
        suggested_action: 'run `leash status` and check the policy',
      });
  }
}
