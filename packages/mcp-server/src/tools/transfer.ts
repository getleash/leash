import { encodeFunctionData, type Address, type Hex } from 'viem';
import {
  erc20Abi,
  formatUsdc,
  parseUsdc,
  type MCPError,
} from '@getleash/core';
import {
  buildUnsignedUserOp,
  encodeSingleExecute,
  getUserOpHash,
  sponsorUserOp,
  submitUserOp,
} from '@getleash/bundler';
import type { ToolContext } from './types.js';
import { checkPolicy } from '../policy.js';
import { buildMcpError, sessionKeyExpired } from '../errors.js';
import { policyDenialToMcpError } from '../proxy/policy-errors.js';

// ─── transfer ────────────────────────────────────────────────────────
//
// USDC UserOp to a whitelisted counterparty. Signed by the session
// key; routed through Kernel → SessionKeyValidator.
//
// Lifecycle:
//   1. Policy check (per-tx cap, recipient allowlist, daily/weekly/
//      monthly budgets, session-key expiry).
//   2. Build unsigned UserOp (Kernel nonce uses SessionKeyValidator).
//   3. Session key signs the EntryPoint userOpHash (raw 65-byte ECDSA).
//   4. Insert into payment log with status='pending' — budget is
//      reserved for the duration of the in-flight op.
//   5. Submit handleOps via the hub-owner bundler wallet.
//   6. On confirm: update to status='confirmed' + tx hash + gas.
//      On revert: update to status='failed' (budget refunded).
//
// This path explicitly does NOT attach VerifyingPaymaster sponsorship —
// the sub-account pays its own gas via its EntryPoint deposit.
// A future change wires paymasterAndData when we settle on the
// sponsorship flow. Today, the sub-account MUST have an EntryPoint
// deposit — document in the error if a deposit-exhausted revert surfaces.

export interface TransferInput {
  to: Address;
  /** Amount as decimal USDC string — e.g. "1.00". */
  amount_usdc: string;
}

export interface TransferOutput {
  tx_hash: Hex;
  user_op_hash: Hex;
  block_number: number;
  gas_used: number;
  amount_usdc: string;
  recipient: Address;
  grant_id: string;
}

export async function handleTransfer(
  ctx: ToolContext,
  input: TransferInput,
): Promise<TransferOutput | MCPError> {
  const amount = safeParseUsdc(input.amount_usdc);
  if (!amount.ok) return amount.error;

  // ── 1. Policy check ───────────────────────────────────────────────
  const policy = checkPolicy({
    grant: ctx.runtime.signedGrant.grant,
    amount: amount.value,
    target: { kind: 'transfer', recipient: input.to },
    db: ctx.db,
  });
  if (!policy.ok) {
    return policyDenialToMcpError(policy.denialCode, policy.details);
  }

  // ── 2-4. Build, sign, insert pending ──────────────────────────────
  if (!ctx.bundlerWallet) {
    return buildMcpError({
      code: 'CONFIG_MISSING',
      category: 'config',
      text: 'Leash: transfer tool invoked without a bundler wallet. This is a configuration error on the server side.',
      details: { hint: 'bundler_wallet_missing' },
      suggested_action: 'restart leash serve; if persistent, re-run `leash apply`',
    });
  }

  const innerCallData = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [input.to, amount.value],
  });
  const callData = encodeSingleExecute({
    target: ctx.runtime.chainConfig.usdc,
    value: 0n,
    innerCallData,
  });

  const sessionKey = ctx.sessionKeys.loadAgentKey(ctx.runtime.agentName);
  if (
    sessionKey.address.toLowerCase() !==
    ctx.runtime.signedGrant.grant.agent.toLowerCase()
  ) {
    return sessionKeyExpired(
      ctx.runtime.agentName,
      new Date(ctx.runtime.signedGrant.grant.validUntil * 1000).toISOString(),
    );
  }

  const unsigned = await buildUnsignedUserOp({
    sender: ctx.runtime.agent.subAccount,
    validator: ctx.runtime.chainConfig.sessionKeyValidator,
    entryPoint: ctx.runtime.chainConfig.entryPoint,
    callData,
    publicClient: ctx.publicClient,
  });

  // ── Paymaster sponsorship ────────────────────────────────────────
  // Once the canonical VerifyingPaymaster is deployed (address
  // non-zero in ChainConfig), attach sponsorship signed by the hub
  // owner (who serves as the paymaster's verifying signer per
  // summary/paymaster-scope.md). Pre-deploy, chainConfig.verifyingPaymaster
  // stays zero and we submit without paymasterAndData — sub-account
  // pays its own gas from its EntryPoint deposit.
  const paymaster = ctx.runtime.chainConfig.verifyingPaymaster;
  if (paymaster !== '0x0000000000000000000000000000000000000000') {
    const verifyingSigner = ctx.sessionKeys.loadHubOwnerKey();
    await sponsorUserOp({
      userOp: unsigned,
      paymaster,
      publicClient: ctx.publicClient,
      verifyingSigner,
    });
  }

  const userOpHash = await getUserOpHash(
    ctx.publicClient,
    ctx.runtime.chainConfig.entryPoint,
    unsigned,
  );
  const signature = await sessionKey.sign({ hash: userOpHash });
  const signedOp = { ...unsigned, signature };

  const pendingId = ctx.db.insertPayment({
    grantId: ctx.runtime.signedGrant.grant.id,
    kind: 'userop',
    amount: amount.value,
    recipient: input.to,
    userOpHash,
    status: 'pending',
  });

  // ── 5-6. Submit + reconcile ───────────────────────────────────────
  try {
    const res = await submitUserOp({
      userOp: signedOp,
      entryPoint: ctx.runtime.chainConfig.entryPoint,
      bundlerWallet: ctx.bundlerWallet,
      publicClient: ctx.publicClient,
    });

    if (!res.success) {
      ctx.db.failPayment({
        id: pendingId,
        error: res.error ?? 'unknown submission failure',
      });
      return buildMcpError({
        code: 'FACILITATOR_REJECTED',
        category: 'upstream',
        text:
          `Leash: the transfer UserOp failed on-chain. ` +
          `Error: '${res.error}'. ` +
          `Check the sub-account's EntryPoint deposit and recipient allowlist, ` +
          `then re-run.`,
        details: {
          user_op_hash: userOpHash,
          tx_hash: res.txHash,
          error: res.error,
        },
        suggested_action: `leash status`,
      });
    }

    ctx.db.confirmPayment({
      id: pendingId,
      txHash: res.txHash,
      blockNumber: res.blockNumber ?? 0n,
      gasUsed: res.actualGasUsed ?? 0n,
    });

    return {
      tx_hash: res.txHash,
      user_op_hash: userOpHash,
      block_number: Number(res.blockNumber ?? 0n),
      gas_used: Number(res.actualGasUsed ?? 0n),
      amount_usdc: formatUsdc(amount.value),
      recipient: input.to,
      grant_id: ctx.runtime.signedGrant.grant.id,
    };
  } catch (e) {
    ctx.db.failPayment({
      id: pendingId,
      error: (e as Error).message,
    });
    throw e;
  }
}

// ─── helpers ─────────────────────────────────────────────────────────

function safeParseUsdc(
  s: string,
): { ok: true; value: bigint } | { ok: false; error: MCPError } {
  try {
    return { ok: true, value: parseUsdc(s) };
  } catch {
    return {
      ok: false,
      error: buildMcpError({
        code: 'CONFIG_MISSING',
        category: 'config',
        text: `Leash: amount "${s}" is not a valid USDC decimal (e.g. "1.00").`,
        details: { amount: s },
        suggested_action: 'retry with a decimal like "0.10"',
      }),
    };
  }
}

