import type { Hex } from 'viem';

// ─── EntryPoint v0.7 PackedUserOperation gas-field layouts ──────────
//
// Two fields pack two uint128s each into a single bytes32:
//   accountGasLimits = verificationGasLimit (hi 16B) || callGasLimit (lo 16B)
//   gasFees          = maxPriorityFeePerGas (hi 16B) || maxFeePerGas (lo 16B)
//
// No surprises, but the layout is easy to get wrong (endianness, padding).
// Both helpers assert that inputs fit in uint128 so corruption surfaces
// loudly rather than silently wrapping.

const U128_MAX = (1n << 128n) - 1n;

function toHex16(v: bigint, field: string): string {
  if (v < 0n) throw new Error(`${field}: negative bigint`);
  if (v > U128_MAX) throw new Error(`${field}: overflows uint128 (got ${v})`);
  return v.toString(16).padStart(32, '0');
}

/** Pack (verificationGasLimit, callGasLimit) into the bytes32 v0.7 format. */
export function packAccountGasLimits(
  verificationGasLimit: bigint,
  callGasLimit: bigint,
): Hex {
  return `0x${toHex16(verificationGasLimit, 'verificationGasLimit')}${toHex16(
    callGasLimit,
    'callGasLimit',
  )}` as Hex;
}

/** Pack (maxPriorityFeePerGas, maxFeePerGas) into the bytes32 v0.7 format. */
export function packGasFees(
  maxPriorityFeePerGas: bigint,
  maxFeePerGas: bigint,
): Hex {
  return `0x${toHex16(maxPriorityFeePerGas, 'maxPriorityFeePerGas')}${toHex16(
    maxFeePerGas,
    'maxFeePerGas',
  )}` as Hex;
}

/** Unpack a (hi16, lo16) bytes32 for tests or diagnostics. */
export function unpackPair(packed: Hex): [bigint, bigint] {
  if (!/^0x[0-9a-fA-F]{64}$/.test(packed)) {
    throw new Error(`unpackPair: expected 32-byte hex, got "${packed}"`);
  }
  const hi = BigInt('0x' + packed.slice(2, 34));
  const lo = BigInt('0x' + packed.slice(34, 66));
  return [hi, lo];
}
