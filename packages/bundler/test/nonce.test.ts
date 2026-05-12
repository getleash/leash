import { describe, expect, it } from 'vitest';
import {
  KERNEL_MODE_DEFAULT,
  KERNEL_VTYPE_PERMISSION,
  KERNEL_VTYPE_VALIDATOR,
  encodeKernelNonce,
  encodeKernelNonceKey,
} from '../src/nonce.js';

const VALIDATOR = '0x224c21cc0F38AE4251d2E0a5a8c40fE19A615c9D';

describe('encodeKernelNonceKey', () => {
  it('produces a 192-bit key with validator in bytes [2:22]', () => {
    const key = encodeKernelNonceKey({ validator: VALIDATOR });
    expect(key).toBeTypeOf('bigint');
    // 192 bits exactly, no overflow.
    expect(key).toBeLessThan(1n << 192n);
    expect(key).toBeGreaterThanOrEqual(0n);
  });

  it('defaults mode=0x00, vType=0x01, nonceKey=0', () => {
    const k = encodeKernelNonceKey({ validator: VALIDATOR });
    // Extract bytes back out: mode=top 8 bits of the 192-bit key,
    // vType=next 8, validator=next 160, nonceKey=bottom 16.
    const mode = Number((k >> 184n) & 0xffn);
    const vType = Number((k >> 176n) & 0xffn);
    const validator = (k >> 16n) & ((1n << 160n) - 1n);
    const nonceKey = Number(k & 0xffffn);
    expect(mode).toBe(KERNEL_MODE_DEFAULT);
    expect(vType).toBe(KERNEL_VTYPE_VALIDATOR);
    expect(validator).toBe(BigInt(VALIDATOR));
    expect(nonceKey).toBe(0);
  });

  it('respects explicit overrides (e.g. permission validator)', () => {
    const k = encodeKernelNonceKey({
      validator: VALIDATOR,
      vType: KERNEL_VTYPE_PERMISSION,
      nonceKey: 0x0042,
    });
    expect(Number((k >> 176n) & 0xffn)).toBe(KERNEL_VTYPE_PERMISSION);
    expect(Number(k & 0xffffn)).toBe(0x0042);
  });

  it('rejects out-of-range bytes', () => {
    expect(() =>
      encodeKernelNonceKey({ validator: VALIDATOR, mode: 256 }),
    ).toThrow(/mode: expected uint8/);
    expect(() =>
      encodeKernelNonceKey({ validator: VALIDATOR, vType: -1 }),
    ).toThrow(/vType: expected uint8/);
    expect(() =>
      encodeKernelNonceKey({ validator: VALIDATOR, nonceKey: 0x10000 }),
    ).toThrow(/nonceKey: expected uint16/);
  });
});

describe('encodeKernelNonce', () => {
  it('combines key and seq into a 256-bit nonce (key in high 192 bits)', () => {
    const key = encodeKernelNonceKey({ validator: VALIDATOR });
    const seq = 7n;
    const nonce = encodeKernelNonce(key, seq);
    expect(nonce >> 64n).toBe(key); // top 192 == key
    expect(nonce & ((1n << 64n) - 1n)).toBe(seq);
  });

  it('rejects out-of-range inputs', () => {
    expect(() => encodeKernelNonce(1n << 192n, 0n)).toThrow(
      /nonceKey out of range/,
    );
    expect(() => encodeKernelNonce(0n, 1n << 64n)).toThrow(/seq out of range/);
  });
});
