import {
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type WalletClient,
  decodeEventLog,
} from 'viem';
import { type PackedUserOperation, entryPointAbi } from '@getleash/core';

// ─── Submission ──────────────────────────────────────────────────────
//
// "Bundler" is a misleading name for this layer in MVP: we always
// submit one UserOp at a time via `EntryPoint.handleOps([op], beneficiary)`.
// The bundler wallet is any funded EOA — the EntryPoint refunds gas to
// the beneficiary passed in. Same wallet for both is fine.

export interface SubmitUserOpParams {
  userOp: PackedUserOperation;
  entryPoint: Address;
  /** Wallet that writes `handleOps` (must have ETH for gas). */
  bundlerWallet: WalletClient;
  publicClient: PublicClient;
  /** Gas-refund recipient. Defaults to the bundler wallet's account. */
  beneficiary?: Address;
}

export interface SubmitUserOpResult {
  /** True if the wrapping handleOps tx succeeded AND the inner UserOp succeeded. */
  success: boolean;
  /** Transaction hash of the handleOps tx (always present, even on failure). */
  txHash: Hex;
  /** UserOp hash emitted by EntryPoint.UserOperationEvent (present on success). */
  userOpHash?: Hex;
  /** Actual gas used by the UserOp, per UserOperationEvent.actualGasUsed. */
  actualGasUsed?: bigint;
  /** Actual gas cost (actualGasUsed * gasPrice). */
  actualGasCost?: bigint;
  blockNumber?: bigint;
  /** If `success` is false, either the handleOps tx reverted or the inner op reverted. */
  error?: string;
}

/**
 * Submit a signed UserOp to the EntryPoint and wait for inclusion.
 * Parses the `UserOperationEvent` to learn the inner success flag and
 * actual gas, which are the authoritative answers (the tx succeeding
 * only tells us validation passed).
 */
export async function submitUserOp({
  userOp,
  entryPoint,
  bundlerWallet,
  publicClient,
  beneficiary,
}: SubmitUserOpParams): Promise<SubmitUserOpResult> {
  if (!bundlerWallet.account) {
    throw new Error('submitUserOp: bundlerWallet must have an account attached');
  }
  const bfcy = beneficiary ?? bundlerWallet.account.address;

  const txHash = await bundlerWallet.writeContract({
    address: entryPoint,
    abi: entryPointAbi,
    functionName: 'handleOps',
    args: [[userOp], bfcy],
    account: bundlerWallet.account,
    chain: bundlerWallet.chain ?? null,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  if (receipt.status !== 'success') {
    return {
      success: false,
      txHash,
      blockNumber: receipt.blockNumber,
      error: 'handleOps transaction reverted',
    };
  }

  const parsed = parseUserOpEvent(receipt.logs, entryPoint);

  return {
    success: parsed ? parsed.success : false,
    txHash,
    userOpHash: parsed?.userOpHash,
    actualGasUsed: parsed?.actualGasUsed,
    actualGasCost: parsed?.actualGasCost,
    blockNumber: receipt.blockNumber,
    error: parsed
      ? parsed.success
        ? undefined
        : 'UserOp execution reverted (validation passed, inner call failed)'
      : 'no UserOperationEvent in receipt (did the tx actually submit the op?)',
  };
}

// ─── Event parsing ───────────────────────────────────────────────────

export interface ParsedUserOpEvent {
  userOpHash: Hex;
  sender: Address;
  paymaster: Address;
  nonce: bigint;
  success: boolean;
  actualGasCost: bigint;
  actualGasUsed: bigint;
}

/**
 * Find and decode the EntryPoint's `UserOperationEvent` from a receipt's
 * logs. Returns `undefined` if none is found (rare — would mean the
 * handleOps call didn't include our op).
 *
 * Exported so the MCP server / tests can parse a receipt without
 * re-submitting. Also the only layer that speaks directly in
 * event-decode terms — the rest of this module takes receipts on faith.
 */
export function parseUserOpEvent(
  logs: Log[],
  entryPoint: Address,
): ParsedUserOpEvent | undefined {
  const target = entryPoint.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== target) continue;
    try {
      const decoded = decodeEventLog({
        abi: entryPointAbi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== 'UserOperationEvent') continue;
      const args = decoded.args as unknown as {
        userOpHash: Hex;
        sender: Address;
        paymaster: Address;
        nonce: bigint;
        success: boolean;
        actualGasCost: bigint;
        actualGasUsed: bigint;
      };
      return {
        userOpHash: args.userOpHash,
        sender: args.sender,
        paymaster: args.paymaster,
        nonce: args.nonce,
        success: args.success,
        actualGasCost: args.actualGasCost,
        actualGasUsed: args.actualGasUsed,
      };
    } catch {
      // Not a UserOperationEvent — try the next log.
    }
  }
  return undefined;
}
