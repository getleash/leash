import { describe, expect, it } from 'vitest';
import { packAccountGasLimits, packGasFees, unpackPair } from '../src/pack.js';

describe('packAccountGasLimits', () => {
  it('packs verification || call into a 32-byte hex', () => {
    // 500_000 = 0x7a120, 300_000 = 0x493e0
    expect(packAccountGasLimits(500_000n, 300_000n)).toBe(
      '0x00000000000000000000000000075120'.replace('75120', '7a120') +
        '000000000000000000000000000493e0',
    );
  });

  it('round-trips through unpackPair', () => {
    const packed = packAccountGasLimits(123_456n, 789_012n);
    expect(unpackPair(packed)).toEqual([123_456n, 789_012n]);
  });

  it('rejects values > uint128', () => {
    expect(() => packAccountGasLimits(1n << 128n, 0n)).toThrow(
      /overflows uint128/,
    );
  });

  it('rejects negative bigints', () => {
    expect(() => packAccountGasLimits(-1n, 0n)).toThrow(/negative bigint/);
  });
});

describe('packGasFees', () => {
  it('packs priority || max into a 32-byte hex', () => {
    const packed = packGasFees(1_000_000n, 7_000_000n);
    expect(packed).toMatch(/^0x[0-9a-f]{64}$/);
    const [priority, max] = unpackPair(packed);
    expect(priority).toBe(1_000_000n);
    expect(max).toBe(7_000_000n);
  });
});
