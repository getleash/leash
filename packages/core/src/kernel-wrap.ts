import {
  type Address,
  type Hex,
  concatHex,
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  toBytes,
} from 'viem';
import {
  KERNEL_DOMAIN_NAME,
  KERNEL_DOMAIN_VERSION,
  KERNEL_ROOT_VALIDATOR_PREFIX,
  KERNEL_WRAPPER_TYPEHASH,
} from './constants.js';

// ─── Kernel EIP-712 envelope ─────────────────────────────────────────
//
// Reproduces Kernel v3.3's `_toWrappedHash` exactly — see
// `contracts/lib/kernel/src/Kernel.sol::_toWrappedHash` and PoC-A's
// Foundry `_kernelWrap` helper (poc/a-kernel-x402/test/PoCKernelX402.t.sol).
//
// The wrap composes: domain ⊕ `Kernel(bytes32 hash)` typehash ⊕ the
// inner hash (USDC EIP-3009 digest, typically). Signing the resulting
// digest with a session key — then prepending the 0x00 root-validator
// selector byte (`prefixRootValidatorSignature`) — yields a signature
// that Kernel's ERC-1271 path accepts on-chain, which is what makes
// EIP-3009 via USDC's `SignatureChecker` work.
//
// Verified live on Base mainnet 2026-04-14 (see poc/a-kernel-x402/README.md).

export interface WrapForKernelParams {
  /** The inner 32-byte digest to wrap (e.g. USDC's TransferWithAuthorization digest). */
  innerHash: Hex;
  /** The Kernel sub-account's address (verifying contract in the Kernel domain). */
  subAccount: Address;
  /** Chain ID for the EIP-712 domain. */
  chainId: number;
}

/**
 * Compute Kernel's wrapped EIP-712 digest. Sign this with the session
 * key, then call {@link prefixRootValidatorSignature} on the result.
 *
 * Equivalent to Kernel.sol's `_toWrappedHash(hash)` on the sub-account.
 */
export function wrapForKernel({
  innerHash,
  subAccount,
  chainId,
}: WrapForKernelParams): Hex {
  return hashTypedData({
    domain: {
      name: KERNEL_DOMAIN_NAME,
      version: KERNEL_DOMAIN_VERSION,
      chainId,
      verifyingContract: subAccount,
    },
    types: {
      Kernel: [{ name: 'hash', type: 'bytes32' }],
    },
    primaryType: 'Kernel',
    message: { hash: innerHash },
  });
}

/**
 * Manual, step-by-step construction of the same digest — kept as a
 * reference implementation AND as a cross-check target in
 * `kernel-wrap.test.ts`. Mirrors PoC-A's `cmdSettle` byte-for-byte so
 * that if viem's `hashTypedData` ever changes behavior, the parity
 * test catches it.
 *
 * Not the preferred call site — use {@link wrapForKernel} in
 * production code.
 */
export function wrapForKernelManual({
  innerHash,
  subAccount,
  chainId,
}: WrapForKernelParams): Hex {
  const EIP712_DOMAIN_TYPEHASH = keccak256(
    toBytes(
      'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
    ),
  );
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        EIP712_DOMAIN_TYPEHASH,
        keccak256(toBytes(KERNEL_DOMAIN_NAME)),
        keccak256(toBytes(KERNEL_DOMAIN_VERSION)),
        BigInt(chainId),
        subAccount,
      ],
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }],
      [KERNEL_WRAPPER_TYPEHASH, innerHash],
    ),
  );
  return keccak256(concatHex(['0x1901', domainSeparator, structHash]));
}

// ─── Root-validator prefix ───────────────────────────────────────────

/**
 * Prepend the root-validator selector byte (0x00) to a raw ECDSA
 * signature. Kernel's `ValidatorLib.decodeSignature` reads this byte
 * to route the signature; `0x00` means "the active root validator."
 *
 * Session keys on a Leash sub-account ride the root path because the
 * SessionKeyValidator is installed as the active validator during
 * `leash apply` (for UserOps; the 1271 path also uses the root
 * selector).
 */
export function prefixRootValidatorSignature(innerSig: Hex): Hex {
  // innerSig is 0x + 130 hex chars = 65 bytes (r/s/v).
  if (innerSig.length !== 132 || !innerSig.startsWith('0x')) {
    throw new Error(
      `prefixRootValidatorSignature expects a 65-byte ECDSA signature, got length ${innerSig.length}`,
    );
  }
  return `${KERNEL_ROOT_VALIDATOR_PREFIX}${innerSig.slice(2)}` as Hex;
}

/**
 * Prepend Kernel's secondary-validator routing prefix (`0x01 || validatorAddress`)
 * to a signature. Used when the signing path is the SessionKeyValidator
 * installed as a non-root module (the production setup). Kernel's outer
 * routing strips these 21 bytes before handing the inner sig to the
 * validator's `isValidSignatureWithSender`.
 *
 * The `innerSig` here is whatever the validator expects internally — for
 * the witness-bearing SessionKeyValidator (v2), that's
 * `ECDSA(65) || abi.encode(witness)` (225 bytes total).
 */
export function prefixSecondaryValidatorSignature(
  validator: Address,
  innerSig: Hex,
): Hex {
  if (!innerSig.startsWith('0x')) {
    throw new Error('prefixSecondaryValidatorSignature expects a 0x-prefixed sig');
  }
  return concatHex(['0x01', validator, innerSig]);
}

// ─── EIP-3009 witness payload (v2 / on-chain per-recipient cap) ─────

export interface Eip3009WitnessParams {
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  /** 32-byte authorization nonce — same as the value signed in the digest. */
  nonce: Hex;
}

/**
 * Encode the EIP-3009 authorization fields as the 160-byte `witness`
 * payload the SessionKeyValidator's 1271 path expects after the ECDSA
 * portion of the signature.
 *
 * Layout: `abi.encode(address to, uint256 value, uint256 validAfter,
 *                     uint256 validBefore, bytes32 nonce)`.
 *
 * `from` is implicit (the sub-account's address — `msg.sender` of the
 * 1271 call inside USDC's SignatureChecker), so it's not carried in the
 * witness. The validator rebuilds the USDC digest from `(from=msg.sender,
 * to, value, validAfter, validBefore, nonce)` and requires equality
 * against the supplied `hash`, binding the witness to the signed message.
 */
export function encodeEip3009Witness(p: Eip3009WitnessParams): Hex {
  return encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'bytes32' },
    ],
    [p.to, p.value, p.validAfter, p.validBefore, p.nonce],
  );
}

export interface BuildWitnessSignatureParams {
  validator: Address;
  /** 65-byte ECDSA signature over the Kernel-wrapped digest. */
  ecdsaSig: Hex;
  witness: Eip3009WitnessParams;
}

/**
 * Build the outer 1271 signature for a witness-bearing SessionKeyValidator
 * call. Returns `0x01 || validator(20) || ECDSA(65) || witness(160)` — the
 * exact bytes USDC's `SignatureChecker.isValidSignatureNow` hands to the
 * sub-account's `isValidSignature`. Kernel's outer routing strips the
 * 22-byte prefix and dispatches the inner 225 bytes to the validator.
 */
export function buildWitnessOuter1271Signature(
  p: BuildWitnessSignatureParams,
): Hex {
  if (p.ecdsaSig.length !== 132 || !p.ecdsaSig.startsWith('0x')) {
    throw new Error(
      `buildWitnessOuter1271Signature expects a 65-byte ECDSA signature, got length ${p.ecdsaSig.length}`,
    );
  }
  const witnessHex = encodeEip3009Witness(p.witness);
  // 0x01 || validator || ECDSA || witness
  return concatHex(['0x01', p.validator, p.ecdsaSig, witnessHex]);
}

// ─── USDC EIP-3009 digest ────────────────────────────────────────────

export interface TransferWithAuthorizationParams {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  /** USDC contract address. */
  usdc: Address;
  /** USDC EIP-712 domain name (e.g. "USD Coin" on mainnet). */
  usdcDomainName: string;
  /** USDC EIP-712 domain version (always "2" for FiatTokenV2_2). */
  usdcDomainVersion: string;
  chainId: number;
}

/**
 * Compute the USDC `TransferWithAuthorization` EIP-712 digest — the
 * "inner hash" that gets wrapped by {@link wrapForKernel} for the x402
 * hot path. Colocated with the Kernel wrap because the two always
 * compose together; separating them invites the next implementer to
 * re-derive the domain fields.
 */
export function hashTransferWithAuthorization(
  p: TransferWithAuthorizationParams,
): Hex {
  return hashTypedData({
    domain: {
      name: p.usdcDomainName,
      version: p.usdcDomainVersion,
      chainId: p.chainId,
      verifyingContract: p.usdc,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: p.from,
      to: p.to,
      value: p.value,
      validAfter: p.validAfter,
      validBefore: p.validBefore,
      nonce: p.nonce,
    },
  });
}
