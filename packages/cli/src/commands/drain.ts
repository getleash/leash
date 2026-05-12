import { encodeFunctionData, encodePacked, type Hex } from 'viem';
import {
  erc20Abi,
  formatUsdc,
  kernelAbi,
} from '@getleash/core';
import {
  createRuntimeWalletClient,
  loadCliRuntime,
  runWithConfig,
} from '../runtime.js';

// ─── leash drain <agent> ─────────────────────────────────────────────
//
// The mandatory recovery path. Moves the full sub-account USDC balance
// back to the hub via a direct tx from the hub owner EOA to
// `Kernel(subAccount).execute(USDC.transfer(hub, balance))`.
//
// Uses the same root-hook path as `apply` and `fund` —
// `ECDSAValidator.preCheck` validates msg.sender == owner. NOT routed
// through the SessionKeyValidator, which would reject transfers to
// the hub (hub is not a policy counterparty, and rightly so — we
// don't want agents to accidentally drain their own budget into the
// hub during normal operation).
//
// Unlimited. Bypasses every policy cap. Matches the
// `drain_to_hub: enabled` contract the policy parser enforces.

const KERNEL_EXEC_MODE_SINGLE_DEFAULT: Hex = ('0x' + '00'.repeat(32)) as Hex;

export async function drain(args: string[]): Promise<number> {
  const agentName = args[0];
  if (!agentName) {
    process.stderr.write('leash drain: usage: leash drain <agent>\n');
    return 2;
  }
  return runWithConfig(() => drainImpl(agentName));
}

async function drainImpl(agentName: string): Promise<number> {
  const cli = loadCliRuntime({ agentName });
  const { runtime, publicClient } = cli;

  const hubOwner = cli.sessionKeys.loadHubOwnerKey();
  if (hubOwner.address.toLowerCase() !== runtime.hub.owner.toLowerCase()) {
    process.stderr.write(
      `leash drain: hub-owner key (${hubOwner.address}) does not match ` +
        `config.owner (${runtime.hub.owner}). Refusing to sign.\n`,
    );
    return 2;
  }

  const subBalance = (await publicClient.readContract({
    address: runtime.chainConfig.usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [runtime.agent.subAccount],
  })) as bigint;
  if (subBalance === 0n) {
    process.stdout.write(
      `leash drain ${agentName}: sub-account balance is 0.00 USDC — nothing to drain.\n`,
    );
    return 0;
  }

  const wallet = createRuntimeWalletClient(runtime, hubOwner);

  const innerCallData = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [runtime.hub.hub, subBalance],
  });
  const execData = encodePacked(
    ['address', 'uint256', 'bytes'],
    [runtime.chainConfig.usdc, 0n, innerCallData],
  );

  process.stdout.write(
    `leash drain ${agentName} ${formatUsdc(subBalance)} USDC:\n` +
      `  sub       ${runtime.agent.subAccount}\n` +
      `  → hub     ${runtime.hub.hub}\n` +
      `  submitting…\n`,
  );

  const txHash = await wallet.writeContract({
    address: runtime.agent.subAccount,
    abi: kernelAbi,
    functionName: 'execute',
    args: [KERNEL_EXEC_MODE_SINGLE_DEFAULT, execData],
    account: hubOwner,
    chain: wallet.chain ?? null,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') {
    process.stderr.write(`leash drain: tx ${txHash} reverted.\n`);
    return 1;
  }
  process.stdout.write(
    `  ✓ drained. tx ${txHash} (block ${receipt.blockNumber}, ${receipt.gasUsed} gas)\n`,
  );
  return 0;
}
