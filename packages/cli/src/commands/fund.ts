import { encodeFunctionData, encodePacked, type Hex } from 'viem';
import {
  erc20Abi,
  formatUsdc,
  kernelAbi,
  parseUsdc,
} from '@getleash/core';
import {
  createRuntimeWalletClient,
  loadCliRuntime,
  runWithConfig,
} from '../runtime.js';

// ─── leash fund <agent> <amount> ─────────────────────────────────────
//
// Moves USDC from the hub → the agent's sub-account. Direct tx from
// the hub owner EOA to `Kernel(hub).execute(USDC.transfer(sub, amount))`.
// Authorized via Kernel's `onlyEntryPointOrSelfOrRoot` modifier, which
// delegates to `ECDSAValidator.preCheck` — matching the same path
// Phase 7c's `apply` uses for `installModule` / `execute`.
//
// Pre-Phase-7c this was a UserOp path that required a paymaster or
// EntryPoint deposit. Direct calls sidestep that entirely — hub
// owner pays gas with ETH (which it already needs for deploys). No
// change for the agent-facing `transfer` tool, which still needs
// the session-key path through SessionKeyValidator.

// CALLTYPE_SINGLE + default exec — 32 zero bytes. Matches
// @getleash/bundler/src/user-op.ts::KERNEL_EXEC_MODE_SINGLE_DEFAULT.
const KERNEL_EXEC_MODE_SINGLE_DEFAULT: Hex = ('0x' + '00'.repeat(32)) as Hex;

export async function fund(args: string[]): Promise<number> {
  if (args.length < 2) {
    process.stderr.write(
      'leash fund: usage: leash fund <agent> <amount-in-usdc>\n',
    );
    return 2;
  }
  const [agentName, amountStr] = args;
  let amount: bigint;
  try {
    amount = parseUsdc(amountStr);
  } catch {
    process.stderr.write(
      `leash fund: invalid amount "${amountStr}". Use a decimal like 1.00.\n`,
    );
    return 2;
  }
  if (amount === 0n) {
    process.stderr.write('leash fund: amount must be > 0.\n');
    return 2;
  }
  return runWithConfig(() => fundImpl(agentName, amount));
}

async function fundImpl(agentName: string, amount: bigint): Promise<number> {
  const cli = loadCliRuntime({ agentName });
  const { runtime, publicClient } = cli;

  const hubOwner = cli.sessionKeys.loadHubOwnerKey();
  if (hubOwner.address.toLowerCase() !== runtime.hub.owner.toLowerCase()) {
    process.stderr.write(
      `leash fund: hub-owner key (${hubOwner.address}) does not match ` +
        `config.owner (${runtime.hub.owner}). Refusing to sign.\n`,
    );
    return 2;
  }

  const hubBalance = (await publicClient.readContract({
    address: runtime.chainConfig.usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [runtime.hub.hub],
  })) as bigint;
  if (hubBalance < amount) {
    process.stderr.write(
      `leash fund: hub balance is ${formatUsdc(hubBalance)} USDC, requested ${formatUsdc(amount)}.\n\n` +
        `Either send more USDC to the hub (${runtime.hub.hub}), or lower the amount.\n`,
    );
    return 1;
  }

  const wallet = createRuntimeWalletClient(runtime, hubOwner);

  // Kernel.execute(mode, packed(target, value, innerCallData)).
  const innerCallData = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [runtime.agent.subAccount, amount],
  });
  const execData = encodePacked(
    ['address', 'uint256', 'bytes'],
    [runtime.chainConfig.usdc, 0n, innerCallData],
  );

  process.stdout.write(
    `leash fund ${agentName} ${formatUsdc(amount)} USDC:\n` +
      `  hub       ${runtime.hub.hub}\n` +
      `  → sub     ${runtime.agent.subAccount}\n` +
      `  submitting…\n`,
  );

  const txHash = await wallet.writeContract({
    address: runtime.hub.hub,
    abi: kernelAbi,
    functionName: 'execute',
    args: [KERNEL_EXEC_MODE_SINGLE_DEFAULT, execData],
    account: hubOwner,
    chain: wallet.chain ?? null,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') {
    process.stderr.write(`leash fund: tx ${txHash} reverted.\n`);
    return 1;
  }
  process.stdout.write(
    `  ✓ funded. tx ${txHash} (block ${receipt.blockNumber}, ${receipt.gasUsed} gas)\n`,
  );
  return 0;
}
