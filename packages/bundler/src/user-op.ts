import {
  type Address,
  type Hex,
  type PublicClient,
  encodeFunctionData,
  encodePacked,
} from 'viem';
import {
  GAS_DEFAULTS,
  entryPointAbi,
  kernelAbi,
  type PackedUserOperation,
} from '@getleash/core';
import { packAccountGasLimits, packGasFees } from './pack.js';
import {
  encodeKernelNonce,
  encodeKernelNonceKey,
  type EncodeKernelNonceKeyParams,
} from './nonce.js';

// ─── Kernel execute(mode, data) call-data builder ────────────────────
//
// Every SessionKeyValidator-authorized UserOp goes through
// Kernel.execute(mode, data). For MVP we only support CALLTYPE_SINGLE
// (one external call per UserOp). The mode is a bytes32 whose layout is
// defined in `Kernel.utils.ExecLib.encode(...)`; we hand-compute it
// because we only need one specific mode.
//
//   CallType(1B)      = 0x00 (single call)
//   ExecType(1B)      = 0x00 (default, reverts on failure)
//   unused(4B)        = 0x00000000
//   selector(4B)      = 0x00000000
//   payload(22B)      = 0x00 * 22
//
// Observable as: 0x00 + 0x00 + 0x00000000 + 0x00000000 + 0x00*22 = 32 zero bytes.
const KERNEL_EXEC_MODE_SINGLE_DEFAULT: Hex =
  ('0x' + '00'.repeat(32)) as Hex;

export interface EncodeSingleExecuteParams {
  /** Target contract address the sub-account should call. */
  target: Address;
  /** Native value (wei) to forward in the inner call. 0 for ERC-20 ops. */
  value: bigint;
  /** ABI-encoded inner calldata, e.g. `erc20.transfer(to, amount)`. */
  innerCallData: Hex;
}

/**
 * Produce the `callData` field for a PackedUserOperation: a single call
 * to `Kernel.execute(bytes32 mode, bytes data)` with CALLTYPE_SINGLE.
 */
export function encodeSingleExecute({
  target,
  value,
  innerCallData,
}: EncodeSingleExecuteParams): Hex {
  // The execute payload for CALLTYPE_SINGLE is `abi.encodePacked(target,
  // value, innerCallData)` — see SessionKeyValidator's parser in
  // contracts/src/SessionKeyValidator.sol and ExecLib.decodeSingle.
  const execData = encodePacked(
    ['address', 'uint256', 'bytes'],
    [target, value, innerCallData],
  );
  return encodeFunctionData({
    abi: kernelAbi,
    functionName: 'execute',
    args: [KERNEL_EXEC_MODE_SINGLE_DEFAULT, execData],
  });
}

// ─── UserOp builder ──────────────────────────────────────────────────

export interface GasOverrides {
  verificationGasLimit?: bigint;
  callGasLimit?: bigint;
  preVerificationGas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export interface BuildUserOpParams {
  /** Sub-account address the UserOp targets. */
  sender: Address;
  /** The SessionKeyValidator (or other validator) that will authorize this op. */
  validator: Address;
  /** EntryPoint v0.7 address. */
  entryPoint: Address;
  /** `callData` field — usually from `encodeSingleExecute`. */
  callData: Hex;
  /** Public client for reading the EntryPoint nonce + fees. */
  publicClient: PublicClient;
  /** Optional gas / fee overrides; sensible MVP defaults otherwise. */
  gas?: GasOverrides;
  /** Kernel nonce-key shape overrides (default: validator @ slot 0). */
  nonceKey?: Omit<EncodeKernelNonceKeyParams, 'validator'>;
  /** Optional: for counterfactual-account cases, provide initCode. */
  initCode?: Hex;
  /** Optional: pre-built paymaster blob. Default: no paymaster. */
  paymasterAndData?: Hex;
}

/**
 * Build an unsigned PackedUserOperation ready to be hashed + signed.
 * Reads the current sequence from EntryPoint; the returned op has
 * `signature = "0x"`. Call {@link getUserOpHash} next, sign, then
 * assign `.signature`.
 */
export async function buildUnsignedUserOp({
  sender,
  validator,
  entryPoint,
  callData,
  publicClient,
  gas,
  nonceKey,
  initCode,
  paymasterAndData,
}: BuildUserOpParams): Promise<PackedUserOperation> {
  const key = encodeKernelNonceKey({ validator, ...(nonceKey ?? {}) });
  const seq = (await publicClient.readContract({
    address: entryPoint,
    abi: entryPointAbi,
    functionName: 'getNonce',
    args: [sender, key],
  })) as bigint;
  const nonce = encodeKernelNonce(key, seq);

  // Fees: honor overrides; otherwise estimate, falling back to 1 gwei
  // both for maxFee and maxPriority. 1 gwei is safely above Base's
  // typical fee floor for MVP.
  let maxFeePerGas = gas?.maxFeePerGas;
  let maxPriorityFeePerGas = gas?.maxPriorityFeePerGas;
  if (maxFeePerGas === undefined || maxPriorityFeePerGas === undefined) {
    try {
      const est = await publicClient.estimateFeesPerGas();
      maxFeePerGas ??= est.maxFeePerGas ?? 1_000_000_000n;
      maxPriorityFeePerGas ??= est.maxPriorityFeePerGas ?? 1_000_000_000n;
    } catch {
      maxFeePerGas ??= 1_000_000_000n;
      maxPriorityFeePerGas ??= 1_000_000_000n;
    }
  }

  const op: PackedUserOperation = {
    sender,
    nonce,
    initCode: initCode ?? '0x',
    callData,
    accountGasLimits: packAccountGasLimits(
      gas?.verificationGasLimit ?? GAS_DEFAULTS.verificationGasLimit,
      gas?.callGasLimit ?? GAS_DEFAULTS.callGasLimit,
    ),
    preVerificationGas: gas?.preVerificationGas ?? GAS_DEFAULTS.preVerificationGas,
    gasFees: packGasFees(maxPriorityFeePerGas, maxFeePerGas),
    paymasterAndData: paymasterAndData ?? '0x',
    signature: '0x',
  };

  return op;
}

/**
 * Read the canonical UserOp hash from the EntryPoint. This is the
 * digest the session key must sign; on-chain validator uses the same
 * calculation to recover the signer.
 */
export async function getUserOpHash(
  publicClient: PublicClient,
  entryPoint: Address,
  op: PackedUserOperation,
): Promise<Hex> {
  return (await publicClient.readContract({
    address: entryPoint,
    abi: entryPointAbi,
    functionName: 'getUserOpHash',
    args: [op],
  })) as Hex;
}
