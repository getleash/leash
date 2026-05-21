import type { Address } from 'viem';
import { erc20Abi, formatUsdc } from '@getleash/core';
import type { ToolContext } from './types.js';

// ─── get_balance ─────────────────────────────────────────────────────
//
// Read-only. Returns the USDC balance of a given account (default:
// the sub-account). Agent uses this to budget before asking to pay,
// and John uses it via `leash status`.

export interface GetBalanceInput {
  /** Optional override — any address. Defaults to the sub-account. */
  account?: Address;
}

export interface GetBalanceOutput {
  account: Address;
  /** USDC base units (6 decimals). */
  balance_raw: string;
  /** Human-readable (e.g. "1.234567"). */
  balance_usdc: string;
  /** Always "USDC" in MVP — kept for future multi-asset. */
  asset: 'USDC';
}

export async function handleGetBalance(
  ctx: ToolContext,
  input: GetBalanceInput,
): Promise<GetBalanceOutput> {
  const account = input.account ?? ctx.runtime.agent.subAccount;
  const raw = (await ctx.publicClient.readContract({
    address: ctx.runtime.chainConfig.usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account],
  })) as bigint;
  return {
    account,
    balance_raw: raw.toString(),
    balance_usdc: formatUsdc(raw),
    asset: 'USDC',
  };
}
