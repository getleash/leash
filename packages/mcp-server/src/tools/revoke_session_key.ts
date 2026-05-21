import type { Hex } from 'viem';
import { encodePacked } from 'viem';
import { kernelAbi, type MCPError } from '@getleash/core';
import type { ToolContext } from './types.js';
import { buildMcpError } from '../errors.js';

// ─── revoke_session_key ──────────────────────────────────────────────
//
// Hub-owner-signed direct call to Kernel.uninstallValidation on the
// sub-account. Matches LeashIntegration.t.sol's revoke path — the hub
// owner IS the sub-account's root validator EOA, so the call is
// authorized without going through a UserOp / paymaster path.
//
// Trade-off for MVP: the hub owner needs ETH on Base to pay gas for
// the revoke tx (~200k gas). `leash status` surfaces this
// explicitly; `leash apply` seeds the hub with a small ETH float at
// apply time. Wrapping revoke in a UserOp + VerifyingPaymaster is a
// future refinement.
//
// After the tx lands, SessionKeyValidator.isInitialized(subAccount)
// returns false. Any subsequent UserOp signed by the session key
// fails at validateUserOp. The local grant.json is also marked
// `revokedAt: now` so downstream (sponsorUserOp, audit) sees it.

export interface RevokeSessionKeyOutput {
  tx_hash: Hex;
  block_number: number;
  gas_used: number;
  sub_account: `0x${string}`;
  session_key_validator: `0x${string}`;
  revoked_at_ms: number;
}

// Kernel encodes a ValidationId as bytes21 with layout:
//   byte 0      : type byte (0x01 for Validator, 0x02 for Permission)
//   bytes 1..20 : 20-byte identifier (validator address for type 0x01)
//
// We revoke the SessionKeyValidator entry — type 0x01, identifier =
// the validator address from chainConfig.
function encodeValidationId(validator: `0x${string}`): Hex {
  return encodePacked(['bytes1', 'address'], ['0x01', validator]);
}

export async function handleRevokeSessionKey(
  ctx: ToolContext,
): Promise<RevokeSessionKeyOutput | MCPError> {
  if (!ctx.bundlerWallet) {
    return buildMcpError({
      code: 'CONFIG_MISSING',
      category: 'config',
      text: 'Leash: revoke_session_key invoked without a wallet. This is a configuration error on the server side.',
      details: { hint: 'bundler_wallet_missing' },
      suggested_action: 'restart leash serve; if persistent, re-run `leash apply`',
    });
  }

  const hubOwner = ctx.sessionKeys.loadHubOwnerKey();
  if (
    hubOwner.address.toLowerCase() !==
    ctx.runtime.hub.owner.toLowerCase()
  ) {
    return buildMcpError({
      code: 'CONFIG_MISSING',
      category: 'config',
      text:
        `Leash: hub-owner key loaded (${hubOwner.address}) does not match ` +
        `the hub owner registered in .leash/config.json (${ctx.runtime.hub.owner}). ` +
        `Refusing to sign.`,
      details: {
        loaded: hubOwner.address,
        expected: ctx.runtime.hub.owner,
      },
      suggested_action: 're-run `leash apply` to sync keychain + config',
    });
  }

  const skValidator = ctx.runtime.chainConfig.sessionKeyValidator;
  const vId = encodeValidationId(skValidator);

  // The direct-call path: hub owner → Kernel.uninstallValidation(...).
  // Kernel's `uninstallValidation` requires msg.sender to be the
  // EntryPoint OR the root validator account, which the hub owner EOA
  // satisfies for our sub-account topology.
  const txHash = await ctx.bundlerWallet.writeContract({
    address: ctx.runtime.agent.subAccount,
    abi: kernelAbi,
    functionName: 'uninstallValidation',
    args: [vId, '0x', '0x'],
    account: hubOwner,
    chain: ctx.bundlerWallet.chain ?? null,
  });

  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') {
    return buildMcpError({
      code: 'FACILITATOR_REJECTED',
      category: 'upstream',
      text: `Leash: revoke transaction reverted. Hash ${txHash}.`,
      details: { tx_hash: txHash },
      suggested_action: 'inspect the tx on basescan and re-run if transient',
    });
  }

  return {
    tx_hash: txHash,
    block_number: Number(receipt.blockNumber),
    gas_used: Number(receipt.gasUsed),
    sub_account: ctx.runtime.agent.subAccount,
    session_key_validator: skValidator,
    revoked_at_ms: Date.now(),
  };
}
