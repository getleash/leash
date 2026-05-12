import { describe, expect, it } from 'vitest';
import {
  buildWitnessOuter1271Signature,
  encodeEip3009Witness,
  hashTransferWithAuthorization,
  prefixRootValidatorSignature,
  prefixSecondaryValidatorSignature,
  wrapForKernel,
  wrapForKernelManual,
} from './kernel-wrap.js';
import { BASE_MAINNET } from './constants.js';

// Known inputs (a plausible Base-mainnet x402 payment; nothing
// privacy-sensitive). The absolute digest values are not the point of
// these tests — byte-parity between the two computation paths is.
// Parity vs Kernel on-chain is verified in PoC-A's Foundry fork tests.

const SUB_ACCOUNT = '0x6bD660201f64De3064D94Be02D3EaFb5978F2022';
const FROM = SUB_ACCOUNT;
const TO = '0x271189c860DB25bC43173B0335784aD68a680908'; // CMC payTo
const VALUE = 10_000n; // 0.01 USDC
const VALID_AFTER = 1_700_000_000n;
const VALID_BEFORE = 1_700_001_000n;
const NONCE =
  '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

describe('wrapForKernel', () => {
  it('returns a 32-byte digest', () => {
    const d = wrapForKernel({
      innerHash:
        '0x1111111111111111111111111111111111111111111111111111111111111111',
      subAccount: SUB_ACCOUNT,
      chainId: 8453,
    });
    expect(d).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('matches the manual EIP-712 construction byte-for-byte (parity guard)', () => {
    // If this test ever fails, viem's `hashTypedData` diverged from the
    // manual keccak path — the manual path mirrors Kernel's on-chain
    // `_toWrappedHash` (PoC-A verified against real mainnet state),
    // so trust the manual path and treat viem as the drift.
    const params = {
      innerHash:
        '0x2222222222222222222222222222222222222222222222222222222222222222' as const,
      subAccount: SUB_ACCOUNT,
      chainId: 8453,
    };
    expect(wrapForKernel(params)).toBe(wrapForKernelManual(params));
  });

  it('differs when the sub-account changes (domain binds to verifyingContract)', () => {
    const params = {
      innerHash:
        '0x3333333333333333333333333333333333333333333333333333333333333333' as const,
      chainId: 8453,
    };
    const a = wrapForKernel({ ...params, subAccount: SUB_ACCOUNT });
    const b = wrapForKernel({
      ...params,
      subAccount: '0x0000000000000000000000000000000000000001',
    });
    expect(a).not.toBe(b);
  });

  it('differs when chainId changes', () => {
    const params = {
      innerHash:
        '0x4444444444444444444444444444444444444444444444444444444444444444' as const,
      subAccount: SUB_ACCOUNT,
    };
    const a = wrapForKernel({ ...params, chainId: 8453 });
    const b = wrapForKernel({ ...params, chainId: 84532 });
    expect(a).not.toBe(b);
  });
});

describe('hashTransferWithAuthorization', () => {
  it('returns a 32-byte digest', () => {
    const d = hashTransferWithAuthorization({
      from: FROM,
      to: TO,
      value: VALUE,
      validAfter: VALID_AFTER,
      validBefore: VALID_BEFORE,
      nonce: NONCE,
      usdc: BASE_MAINNET.usdc,
      usdcDomainName: BASE_MAINNET.usdcDomainName,
      usdcDomainVersion: BASE_MAINNET.usdcDomainVersion,
      chainId: BASE_MAINNET.chainId,
    });
    expect(d).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is deterministic for identical inputs', () => {
    const mk = () =>
      hashTransferWithAuthorization({
        from: FROM,
        to: TO,
        value: VALUE,
        validAfter: VALID_AFTER,
        validBefore: VALID_BEFORE,
        nonce: NONCE,
        usdc: BASE_MAINNET.usdc,
        usdcDomainName: BASE_MAINNET.usdcDomainName,
        usdcDomainVersion: BASE_MAINNET.usdcDomainVersion,
        chainId: BASE_MAINNET.chainId,
      });
    expect(mk()).toBe(mk());
  });

  it('differs when nonce changes (replay protection works)', () => {
    const base = {
      from: FROM,
      to: TO,
      value: VALUE,
      validAfter: VALID_AFTER,
      validBefore: VALID_BEFORE,
      usdc: BASE_MAINNET.usdc,
      usdcDomainName: BASE_MAINNET.usdcDomainName,
      usdcDomainVersion: BASE_MAINNET.usdcDomainVersion,
      chainId: BASE_MAINNET.chainId,
    };
    const a = hashTransferWithAuthorization({
      ...base,
      nonce:
        '0x1111111111111111111111111111111111111111111111111111111111111111',
    });
    const b = hashTransferWithAuthorization({
      ...base,
      nonce:
        '0x2222222222222222222222222222222222222222222222222222222222222222',
    });
    expect(a).not.toBe(b);
  });
});

describe('prefixRootValidatorSignature', () => {
  it('prepends 0x00 to a 65-byte ECDSA signature', () => {
    const sig =
      '0x' + 'ab'.repeat(65) as `0x${string}`;
    const prefixed = prefixRootValidatorSignature(sig);
    expect(prefixed).toBe('0x00' + 'ab'.repeat(65));
    expect(prefixed).toHaveLength(2 + 2 + 130);
  });

  it('throws on a signature with wrong length', () => {
    expect(() =>
      prefixRootValidatorSignature('0xdeadbeef' as `0x${string}`),
    ).toThrow(/65-byte ECDSA signature/);
  });
});

describe('prefixSecondaryValidatorSignature', () => {
  const VALIDATOR = '0x32fa9feb15b921044eb99ebfeadf17a1f8470b4c' as const;

  it('prepends 0x01 || validator(20) to the inner sig', () => {
    const inner = ('0x' + 'cd'.repeat(225)) as `0x${string}`; // ECDSA(65) + witness(160)
    const out = prefixSecondaryValidatorSignature(VALIDATOR, inner);
    // 0x01 (1) + validator (20) + inner (225) = 246 bytes = 0x + 492 hex chars
    expect(out).toHaveLength(2 + 2 + 40 + 225 * 2);
    expect(out.toLowerCase().startsWith('0x01' + VALIDATOR.slice(2))).toBe(true);
    expect(out.toLowerCase().endsWith('cd'.repeat(225))).toBe(true);
  });
});

describe('encodeEip3009Witness', () => {
  it('produces a 160-byte abi-encoded payload', () => {
    const w = encodeEip3009Witness({
      to: TO,
      value: VALUE,
      validAfter: VALID_AFTER,
      validBefore: VALID_BEFORE,
      nonce: NONCE,
    });
    // 5 × 32 bytes = 160 bytes = 0x + 320 hex chars
    expect(w).toHaveLength(2 + 320);
    expect(w).toMatch(/^0x[0-9a-f]{320}$/);
  });

  it('differs when any field changes', () => {
    const base = {
      to: TO,
      value: VALUE,
      validAfter: VALID_AFTER,
      validBefore: VALID_BEFORE,
      nonce: NONCE,
    } as const;
    const a = encodeEip3009Witness(base);
    expect(encodeEip3009Witness({ ...base, value: VALUE + 1n })).not.toBe(a);
    expect(
      encodeEip3009Witness({
        ...base,
        to: '0x0000000000000000000000000000000000000099',
      }),
    ).not.toBe(a);
  });

  it('round-trips the nonce verbatim (replay-protection invariant)', () => {
    const w = encodeEip3009Witness({
      to: TO,
      value: VALUE,
      validAfter: VALID_AFTER,
      validBefore: VALID_BEFORE,
      nonce: NONCE,
    });
    // Last 32 bytes (64 hex chars) of the abi-encoded witness are the nonce.
    expect(w.slice(-64)).toBe(NONCE.slice(2));
  });
});

describe('buildWitnessOuter1271Signature', () => {
  const VALIDATOR = '0x32fa9feb15b921044eb99ebfeadf17a1f8470b4c' as const;
  const ECDSA = ('0x' + 'ab'.repeat(65)) as `0x${string}`;

  it('returns 0x01 || validator(20) || ECDSA(65) || witness(160) = 246 bytes', () => {
    const out = buildWitnessOuter1271Signature({
      validator: VALIDATOR,
      ecdsaSig: ECDSA,
      witness: {
        to: TO,
        value: VALUE,
        validAfter: VALID_AFTER,
        validBefore: VALID_BEFORE,
        nonce: NONCE,
      },
    });
    expect(out).toHaveLength(2 + 246 * 2);
    expect(out.toLowerCase().startsWith('0x01' + VALIDATOR.slice(2))).toBe(true);
    expect(out.toLowerCase()).toContain('ab'.repeat(65));
  });

  it('throws on wrong-length ECDSA input', () => {
    expect(() =>
      buildWitnessOuter1271Signature({
        validator: VALIDATOR,
        ecdsaSig: '0xdeadbeef' as `0x${string}`,
        witness: {
          to: TO,
          value: VALUE,
          validAfter: VALID_AFTER,
          validBefore: VALID_BEFORE,
          nonce: NONCE,
        },
      }),
    ).toThrow(/65-byte ECDSA signature/);
  });
});
