import {
  createPublicClient,
  http,
  type Chain,
  type PublicClient,
} from 'viem';
import type { ChainConfig } from '@getleash/core';

// ─── Public-client factory ───────────────────────────────────────────
//
// Thin wrapper so all MCP tools get a client from the same place. RPC
// URL resolution: explicit override > env var > public endpoint
// fallback. The public endpoints are rate-limited; for production
// runs users are expected to set LEASH_BASE_RPC (documented in
// summary/install.md).

const PUBLIC_RPC_FALLBACK: Record<string, string> = {
  base: 'https://mainnet.base.org',
  'base-sepolia': 'https://sepolia.base.org',
};

export interface CreatePublicClientParams {
  chainConfig: ChainConfig;
  /** Explicit RPC URL. Overrides env + fallback. */
  rpcUrl?: string;
}

export function resolveRpcUrl(chainConfig: ChainConfig, rpcUrl?: string): string {
  if (rpcUrl) return rpcUrl;
  const envOverride =
    chainConfig.name === 'base'
      ? process.env.LEASH_BASE_RPC
      : process.env.LEASH_BASE_SEPOLIA_RPC;
  if (envOverride) return envOverride;
  return PUBLIC_RPC_FALLBACK[chainConfig.name] ?? PUBLIC_RPC_FALLBACK.base;
}

export function createLeashPublicClient(
  params: CreatePublicClientParams,
): PublicClient {
  return createPublicClient({
    chain: params.chainConfig.chain as Chain,
    transport: http(resolveRpcUrl(params.chainConfig, params.rpcUrl)),
  });
}
