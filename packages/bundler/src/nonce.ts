import type { Address } from 'viem';

// ─── Kernel v3.3 nonce encoding ──────────────────────────────────────
//
// Kernel selects which validator handles a UserOp via the top 192 bits
// of EntryPoint's 256-bit nonce. Layout (mirrors Kernel's
// `ValidatorLib.encodeAsNonce` — see
// contracts/lib/kernel/src/utils/ValidationTypeLib.sol):
//
//   byte 0  (msb)          : mode   (uint8; 0x00 = default)
//   byte 1                 : vType  (uint8; 0x01 = validator, 0x02 = permission)
//   bytes 2-21             : validator address (20 bytes)
//   bytes 22-23            : nonceKey (uint16; independent sequencing slot)
//   bytes 24-31 (lsb)      : seq (uint64; monotonic per (key))
//
// Rationale for the `nonceKey` slot: different slots serialize
// independently. Useful if we ever want to parallelize UserOps without
// one waiting on another. MVP always uses 0.

/** Kernel validator type byte: a regular validator (not a permission). */
export const KERNEL_VTYPE_VALIDATOR = 0x01;
/** Kernel validator type byte: a permission validator. */
export const KERNEL_VTYPE_PERMISSION = 0x02;
/** Default Kernel mode byte. */
export const KERNEL_MODE_DEFAULT = 0x00;

export interface EncodeKernelNonceKeyParams {
  /** The validator contract address handling the UserOp. */
  validator: Address;
  /** Mode byte (default 0x00). */
  mode?: number;
  /** Validator type byte (default 0x01 = validator). */
  vType?: number;
  /** 16-bit parallel-serialization slot (default 0). */
  nonceKey?: number;
}

/**
 * Encode the 192-bit Kernel nonce key. Pass this as the second arg to
 * `EntryPoint.getNonce(sender, key)` to read the next sequence number
 * for this validator, then call {@link encodeKernelNonce} to produce
 * the full 256-bit UserOp nonce.
 */
export function encodeKernelNonceKey({
  validator,
  mode = KERNEL_MODE_DEFAULT,
  vType = KERNEL_VTYPE_VALIDATOR,
  nonceKey = 0,
}: EncodeKernelNonceKeyParams): bigint {
  assertUint8(mode, 'mode');
  assertUint8(vType, 'vType');
  assertUint16(nonceKey, 'nonceKey');

  const validatorInt = BigInt(validator);
  if (validatorInt < 0n || validatorInt >= 1n << 160n) {
    throw new Error(`encodeKernelNonceKey: invalid validator address`);
  }

  return (
    (BigInt(mode) << 184n) |
    (BigInt(vType) << 176n) |
    (validatorInt << 16n) |
    BigInt(nonceKey)
  );
}

/**
 * Combine a Kernel nonce key (192 bits) with a sequence (64 bits) into
 * the 256-bit nonce field expected by PackedUserOperation.
 */
export function encodeKernelNonce(nonceKey: bigint, seq: bigint): bigint {
  if (nonceKey < 0n || nonceKey >= 1n << 192n) {
    throw new Error(`encodeKernelNonce: nonceKey out of range (got ${nonceKey})`);
  }
  if (seq < 0n || seq >= 1n << 64n) {
    throw new Error(`encodeKernelNonce: seq out of range (got ${seq})`);
  }
  return (nonceKey << 64n) | seq;
}

function assertUint8(v: number, field: string): void {
  if (!Number.isInteger(v) || v < 0 || v > 0xff) {
    throw new Error(`${field}: expected uint8, got ${v}`);
  }
}

function assertUint16(v: number, field: string): void {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) {
    throw new Error(`${field}: expected uint16, got ${v}`);
  }
}
