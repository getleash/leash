import type { Address } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import type { ChainName } from './types.js';

// ─── Chain Configs ───────────────────────────────────────────────────
//
// Per-chain runtime constants for Leash. Two distinct sets of fields:
//
//   Stable (chain-canonical):
//     - entryPoint  — ERC-4337 v0.7 EntryPoint, deployed by eth-infinitism.
//     - usdc        — Circle's USDC contract on this chain.
//
//   Phase-8-managed (filled by `scripts/sync-deployments.ts` after a
//   `forge script DeployLeash.s.sol` run):
//     - kernelImpl, kernelFactory, ecdsaValidator   — vendored ZeroDev Kernel v3.3 stack.
//     - leashFactory, sessionKeyValidator, verifyingPaymaster — Leash's own contracts.
//
// Phase-8 fields stay at ZERO until the sync runs — anything that
// reaches for them pre-deploy blows up loudly (e.g. `leash apply`'s
// early-exit guard) instead of silently writing junk on-chain.
//
// We deploy Kernel + KernelFactory + ECDSAValidator from the vendored
// submodule rather than reusing somebody else's deploy. This keeps
// the entire Leash stack reproducible from one repo commit, and
// avoids the failure mode where an inherited "canonical" address
// turns out to be a different contract whose ABI doesn't match.

export interface ChainConfig {
  chain: typeof base | typeof baseSepolia;
  chainId: number;
  name: ChainName;

  // ─── ERC-4337 / Kernel v3.3 ───────────────────────────────────────
  entryPoint: Address;
  /** ZeroDev KernelFactory (creates Kernel proxies via CREATE2). */
  kernelFactory: Address;
  /** ZeroDev Kernel v3.3 implementation (logic contract). */
  kernelImpl: Address;
  /** ZeroDev ECDSAValidator (root validator for hub + sub). */
  ecdsaValidator: Address;

  // ─── Leash contracts (deployed in Phase 8) ────────────────────────
  /** LeashFactory (our thin wrapper on KernelFactory). */
  leashFactory: Address;
  /** Our SessionKeyValidator (installed as secondary on each sub). */
  sessionKeyValidator: Address;
  /** Canonical eth-infinitism VerifyingPaymaster. */
  verifyingPaymaster: Address;

  // ─── USDC (FiatTokenV2_2) ─────────────────────────────────────────
  usdc: Address;
  /** USDC EIP-712 domain name (for TransferWithAuthorization). */
  usdcDomainName: string;
  /** USDC EIP-712 domain version — NOT "2.2". PoC-A verified "2". */
  usdcDomainVersion: string;

  // ─── x402 facilitator ─────────────────────────────────────────────
  /** Coinbase CDP facilitator endpoint (settles EIP-3009 on our behalf). */
  cdpFacilitatorUrl: string;
}

const ENTRYPOINT_V07: Address = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

const ZERO: Address = '0x0000000000000000000000000000000000000000';

export const BASE_MAINNET: ChainConfig = {
  chain: base,
  chainId: 8453,
  name: 'base',
  entryPoint: ENTRYPOINT_V07,
  // Filled by scripts/sync-deployments.ts after a fresh
  // contracts/script/DeployLeash.s.sol run on Base mainnet.
  kernelFactory: '0x1bef84036791aa627e984fdbe32bffcf6c861816',
  kernelImpl: '0xae822a91c79359e3debcdf761c5da968c49df0c9',
  ecdsaValidator: '0x7740aca10483ee68277f0a40d9a68cb3ba3b1d72',
  leashFactory: '0x0d4d6efbd39ee1c7f6f0080f1f106ccf5d4cbd9d',
  sessionKeyValidator: '0xF31271d1aA947B40bd1193b260dc2Ba48BD239E3',
  verifyingPaymaster: '0x9579cffe3f81bf71f0e5405d4c91d92067827441',
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  usdcDomainName: 'USD Coin',
  usdcDomainVersion: '2', // NOT '2.2' — PoC-A confirmed
  cdpFacilitatorUrl: 'https://api.cdp.coinbase.com/platform/v2/x402',
};

export const BASE_SEPOLIA: ChainConfig = {
  chain: baseSepolia,
  chainId: 84532,
  name: 'base-sepolia',
  entryPoint: ENTRYPOINT_V07,
  // ZeroDev deploys the same addresses across chains via CREATE2 — but
  // we leave testnet as TBD until we have a verified deployment.
  kernelFactory: '0xebc3f62df44f388732b2240ec7076ea82aacacc2',
  kernelImpl: '0x4cc651bbd7ffb5b5d9d372a07d7946ddb14c64bc',
  ecdsaValidator: '0x56e4e5f7dd7a3a645c7e68157ac1715bce419cb7',
  leashFactory: '0x781f814645631492f860c3d9b44f68a358e349ea',
  sessionKeyValidator: '0xaB242Ae355Ab350c93d7cBB94Dd77a62c1AA35aF',
  verifyingPaymaster: '0xae822a91c79359e3debcdf761c5da968c49df0c9',
  usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Circle testnet USDC
  usdcDomainName: 'USDC',
  usdcDomainVersion: '2',
  cdpFacilitatorUrl: 'https://api.cdp.coinbase.com/platform/v2/x402',
};

export function getChainConfig(chain: string): ChainConfig {
  switch (chain) {
    case 'base':
      return BASE_MAINNET;
    case 'base-sepolia':
      return BASE_SEPOLIA;
    default:
      throw new Error(`Unknown chain: ${chain}. Use "base" or "base-sepolia".`);
  }
}

// ─── Kernel EIP-712 envelope (for ERC-1271 + EIP-3009 path) ──────────
//
// Kernel v3.3 wraps any signed digest in an EIP-712 envelope with:
//   typehash = keccak256("Kernel(bytes32 hash)")
//   domain   = { name:"Kernel", version:"0.3.3", chainId, verifyingContract: subAccount }
//
// PoC-A confirmed against Kernel's on-chain `_toWrappedHash`. The
// typehash below matches Kernel's `KERNEL_WRAPPER_TYPE_HASH` constant.

export const KERNEL_DOMAIN_NAME = 'Kernel';
export const KERNEL_DOMAIN_VERSION = '0.3.3';
export const KERNEL_WRAPPER_TYPEHASH =
  '0x1547321c374afde8a591d972a084b071c594c275e36724931ff96c25f2999c83' as const;

/**
 * Root-validator selector prefix: every signature sent to Kernel's
 * `isValidSignature` must be prefixed with `0x00` so Kernel's
 * `ValidatorLib.decodeSignature` routes to the root validator.
 * Session keys ride the root path because they're registered as the
 * active validator for the sub-account.
 */
export const KERNEL_ROOT_VALIDATOR_PREFIX = '0x00' as const;

// ─── Gas defaults (MVP generous) ─────────────────────────────────────

export const GAS_DEFAULTS = {
  verificationGasLimit: 500_000n,
  callGasLimit: 300_000n,
  preVerificationGas: 100_000n,
} as const;

// ─── USDC helpers ────────────────────────────────────────────────────

export const USDC_DECIMALS = 6;

/** Parse a human-readable USDC amount (e.g. "1.00") to base units. */
export function parseUsdc(amount: string): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid USDC amount: "${amount}"`);
  }
  const [whole, frac = ''] = trimmed.split('.');
  const padded = frac.padEnd(USDC_DECIMALS, '0').slice(0, USDC_DECIMALS);
  return BigInt(whole + padded);
}

/** Format USDC base units back to a human-readable string. */
export function formatUsdc(amount: bigint): string {
  const str = amount.toString().padStart(USDC_DECIMALS + 1, '0');
  const whole = str.slice(0, -USDC_DECIMALS);
  const frac = str.slice(-USDC_DECIMALS).replace(/0+$/, '') || '0';
  return `${whole}.${frac}`;
}
