import {
  type Address,
  type Hex,
  type PublicClient,
  encodePacked,
} from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import {
  type PackedUserOperation,
  verifyingPaymasterAbi,
} from '@getleash/core';

// ─── ERC-4337 v0.7 paymasterAndData layout ───────────────────────────
//
//   [0:20]   paymaster address
//   [20:36]  paymasterVerificationGasLimit (uint128, 16 bytes)
//   [36:52]  paymasterPostOpGasLimit (uint128, 16 bytes)
//   --- PAYMASTER_DATA_OFFSET = 52 ---
//   [52:58]  validUntil (uint48, 6 bytes)
//   [58:64]  validAfter (uint48, 6 bytes)
//   [64:129] signature (65 bytes: r[32] + s[32] + v[1])
//
// See VerifyingPaymaster.sol:parsePaymasterAndData and its `getHash`.

const DEFAULT_PAYMASTER_VERIFICATION_GAS = 100_000n;
const DEFAULT_PAYMASTER_POSTOP_GAS = 50_000n;
const DEFAULT_VALIDITY_SECONDS = 3600;

// 65-byte placeholder signature used while computing the sponsor hash —
// the paymaster's `getHash` ignores the signature portion, but we must
// keep the paymasterAndData length consistent with its `parsePaymasterAndData`.
const PLACEHOLDER_SIG: Hex = (`0x${'00'.repeat(65)}`) as Hex;

function pack(
  paymaster: Address,
  verificationGas: bigint,
  postOpGas: bigint,
  validUntil: number,
  validAfter: number,
  signature: Hex,
): Hex {
  // encodePacked handles the width-correct concatenation; uint48s get 6
  // bytes, uint128s get 16. No padding surprises.
  return encodePacked(
    ['address', 'uint128', 'uint128', 'uint48', 'uint48', 'bytes'],
    [paymaster, verificationGas, postOpGas, validUntil, validAfter, signature],
  );
}

export interface SponsorUserOpParams {
  userOp: PackedUserOperation;
  paymaster: Address;
  publicClient: PublicClient;
  /** Off-chain signer whose address the paymaster contract trusts. */
  verifyingSigner: PrivateKeyAccount;
  /** Sponsorship `validUntil` (unix seconds). Default: now + 1h. */
  validUntil?: number;
  /** Sponsorship `validAfter` (unix seconds). Default: 0 (immediate). */
  validAfter?: number;
  /** Paymaster verification gas limit (default 100k). */
  paymasterVerificationGas?: bigint;
  /** Paymaster postOp gas limit (default 50k). */
  paymasterPostOpGas?: bigint;
}

/**
 * Attach VerifyingPaymaster sponsorship to a UserOp. Mutates the
 * `paymasterAndData` field in place and returns it for convenience.
 *
 * Flow (matches canonical eth-infinitism VerifyingPaymaster):
 *   1. Pack a placeholder paymasterAndData so the op's structure is
 *      final for hashing purposes.
 *   2. Call `paymaster.getHash(userOp, validUntil, validAfter)` on-chain
 *      to get the sponsor digest.
 *   3. Sign the digest via `signMessage({raw})` — i.e. Ethereum-signed
 *      message prefix, matching the paymaster's
 *      `ECDSA.recover(keccak256("\x19Ethereum...") ...)` on-chain.
 *   4. Re-pack with the real signature.
 */
export async function sponsorUserOp({
  userOp,
  paymaster,
  publicClient,
  verifyingSigner,
  validUntil,
  validAfter,
  paymasterVerificationGas,
  paymasterPostOpGas,
}: SponsorUserOpParams): Promise<Hex> {
  const validU = validUntil ?? Math.floor(Date.now() / 1000) + DEFAULT_VALIDITY_SECONDS;
  const validA = validAfter ?? 0;
  const pmVGas = paymasterVerificationGas ?? DEFAULT_PAYMASTER_VERIFICATION_GAS;
  const pmPGas = paymasterPostOpGas ?? DEFAULT_PAYMASTER_POSTOP_GAS;

  userOp.paymasterAndData = pack(
    paymaster,
    pmVGas,
    pmPGas,
    validU,
    validA,
    PLACEHOLDER_SIG,
  );

  const sponsorHash = (await publicClient.readContract({
    address: paymaster,
    abi: verifyingPaymasterAbi,
    functionName: 'getHash',
    args: [userOp, validU, validA],
  })) as Hex;

  const sig = await verifyingSigner.signMessage({
    message: { raw: sponsorHash },
  });

  userOp.paymasterAndData = pack(paymaster, pmVGas, pmPGas, validU, validA, sig);
  return userOp.paymasterAndData;
}

// ─── Convenience: pack a blank `paymasterAndData` for the "no sponsor" path ──

/** An empty paymasterAndData — the UserOp pays its own gas from the sub-account's EntryPoint deposit. */
export const NO_PAYMASTER: Hex = '0x';
