import { describe, expect, it } from 'vitest';
import {
  BASE_MAINNET,
  BASE_SEPOLIA,
  KERNEL_DOMAIN_NAME,
  KERNEL_DOMAIN_VERSION,
  KERNEL_ROOT_VALIDATOR_PREFIX,
  KERNEL_WRAPPER_TYPEHASH,
  formatUsdc,
  getChainConfig,
  parseUsdc,
  type ChainConfig,
} from './constants.js';

// ─── Deploy-field coherence check ────────────────────────────────────
//
// The six contract-address fields managed by sync-deployments must
// be in one of two states: all six are ZERO (pre-deploy) or all six
// are non-zero, well-formed, and pairwise distinct (post-deploy on
// this chain). Anything else means a partial sync — surface it.

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

function assertDeployFieldsCoherent(cfg: ChainConfig, label: string): void {
  const fields: ReadonlyArray<readonly [string, string]> = [
    ['kernelImpl', cfg.kernelImpl],
    ['kernelFactory', cfg.kernelFactory],
    ['ecdsaValidator', cfg.ecdsaValidator],
    ['leashFactory', cfg.leashFactory],
    ['sessionKeyValidator', cfg.sessionKeyValidator],
    ['verifyingPaymaster', cfg.verifyingPaymaster],
  ];
  const allZero = fields.every(([, v]) => v === ZERO_ADDR);
  const allNonZero = fields.every(([, v]) => v !== ZERO_ADDR);
  expect(
    allZero || allNonZero,
    `${label}: partial deploy — some deploy fields are zero, others aren't:\n` +
      fields.map(([k, v]) => `  ${k}: ${v}`).join('\n'),
  ).toBe(true);
  if (allNonZero) {
    for (const [name, value] of fields) {
      expect(value, `${label}.${name}`).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
    expect(
      new Set(fields.map(([, v]) => v.toLowerCase())).size,
      `${label}: duplicate addresses across deploy fields`,
    ).toBe(fields.length);
  }
}

describe('parseUsdc', () => {
  it('parses whole numbers', () => {
    expect(parseUsdc('100')).toBe(100_000_000n);
  });
  it('parses decimal amounts', () => {
    expect(parseUsdc('50.50')).toBe(50_500_000n);
  });
  it('parses trailing zeros', () => {
    expect(parseUsdc('1.10')).toBe(1_100_000n);
  });
  it('parses zero', () => {
    expect(parseUsdc('0')).toBe(0n);
  });
  it('truncates beyond 6 decimals', () => {
    expect(parseUsdc('1.1234567')).toBe(1_123_456n);
  });
  it('throws on non-numeric input', () => {
    expect(() => parseUsdc('one')).toThrow('Invalid USDC amount');
  });
});

describe('formatUsdc', () => {
  it('formats whole amounts', () => {
    expect(formatUsdc(100_000_000n)).toBe('100.0');
  });
  it('formats decimals', () => {
    expect(formatUsdc(50_500_000n)).toBe('50.5');
  });
  it('formats zero', () => {
    expect(formatUsdc(0n)).toBe('0.0');
  });
  it('formats sub-cent amounts', () => {
    expect(formatUsdc(1n)).toBe('0.000001');
  });
  it('round-trips with parseUsdc', () => {
    expect(formatUsdc(parseUsdc('123.456'))).toBe('123.456');
  });
});

describe('getChainConfig', () => {
  it('returns base mainnet config', () => {
    expect(getChainConfig('base').chainId).toBe(8453);
  });
  it('returns base sepolia config', () => {
    expect(getChainConfig('base-sepolia').chainId).toBe(84532);
  });
  it('throws on unknown chain', () => {
    expect(() => getChainConfig('ethereum')).toThrow('Unknown chain');
  });
});

describe('Base mainnet constants', () => {
  it('pins USDC at the canonical FiatTokenV2_2 address', () => {
    expect(BASE_MAINNET.usdc).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  });
  it('pins EntryPoint v0.7', () => {
    expect(BASE_MAINNET.entryPoint).toBe(
      '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    );
  });
  it('uses USDC domain version "2" (NOT "2.2")', () => {
    // Regression guard: PoC-A found out the hard way that the USDC
    // domain version is "2", not "2.2". Do not "fix" this.
    expect(BASE_MAINNET.usdcDomainVersion).toBe('2');
    expect(BASE_MAINNET.usdcDomainName).toBe('USD Coin');
  });
  it('deploy fields are either all-zero (pre-deploy) or all-set (post-deploy, distinct)', () => {
    assertDeployFieldsCoherent(BASE_MAINNET, 'BASE_MAINNET');
  });
});

describe('Base sepolia constants', () => {
  it('uses Circle testnet USDC', () => {
    expect(BASE_SEPOLIA.usdc).toBe(
      '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    );
  });
  it('deploy fields are either all-zero (pre-deploy) or all-set (post-deploy, distinct)', () => {
    assertDeployFieldsCoherent(BASE_SEPOLIA, 'BASE_SEPOLIA');
  });
});

describe('Kernel EIP-712 envelope constants', () => {
  it('pins the wrapper typehash to Kernel v3.3 on-chain value', () => {
    // Matches Kernel's `KERNEL_WRAPPER_TYPE_HASH` constant; do not edit
    // unless Kernel's source changes. PoC-A verified against mainnet.
    expect(KERNEL_WRAPPER_TYPEHASH).toBe(
      '0x1547321c374afde8a591d972a084b071c594c275e36724931ff96c25f2999c83',
    );
  });
  it('pins Kernel domain name/version', () => {
    expect(KERNEL_DOMAIN_NAME).toBe('Kernel');
    expect(KERNEL_DOMAIN_VERSION).toBe('0.3.3');
  });
  it('pins the root-validator signature prefix to 0x00', () => {
    expect(KERNEL_ROOT_VALIDATOR_PREFIX).toBe('0x00');
  });
});
