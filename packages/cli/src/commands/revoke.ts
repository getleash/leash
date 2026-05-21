import { encodePacked } from 'viem';
import { kernelAbi } from '@getleash/core';
import {
  createRuntimeWalletClient,
  loadCliRuntime,
  runWithConfig,
} from '../runtime.js';

// ─── leash revoke <agent> ────────────────────────────────────────────
//
// Hub owner direct-calls `Kernel(subAccount).uninstallValidation(vId, "", "")`
// — same path the `revoke_session_key` MCP tool uses in-process
// (see packages/mcp-server/src/tools/revoke_session_key.ts). The
// CLI duplicates the call so John can pull the leash without needing
// a running MCP server.
//
// Hub owner needs ETH on Base to pay gas (~200k). `leash status`
// surfaces the hub's ETH balance once that lands; `leash apply`
// seeds the float.

export async function revoke(args: string[]): Promise<number> {
  const agentName = args[0];
  if (!agentName) {
    process.stderr.write('leash revoke: usage: leash revoke <agent>\n');
    return 2;
  }
  return runWithConfig(() => revokeImpl(agentName));
}

async function revokeImpl(agentName: string): Promise<number> {
  const cli = loadCliRuntime({ agentName });
  const { runtime, publicClient } = cli;

  const hubOwner = cli.sessionKeys.loadHubOwnerKey();
  if (hubOwner.address.toLowerCase() !== runtime.hub.owner.toLowerCase()) {
    process.stderr.write(
      `leash revoke: hub-owner key (${hubOwner.address}) does not match ` +
        `config.owner (${runtime.hub.owner}). Refusing to sign.\n`,
    );
    return 2;
  }

  const skValidator = runtime.chainConfig.sessionKeyValidator;
  const vId = encodePacked(['bytes1', 'address'], ['0x01', skValidator]);

  const wallet = createRuntimeWalletClient(runtime, hubOwner);
  process.stdout.write(
    `leash revoke ${agentName}:\n` +
      `  sub       ${runtime.agent.subAccount}\n` +
      `  validator ${skValidator}\n` +
      `  submitting uninstallValidation…\n`,
  );

  const txHash = await wallet.writeContract({
    address: runtime.agent.subAccount,
    abi: kernelAbi,
    functionName: 'uninstallValidation',
    args: [vId, '0x', '0x'],
    account: hubOwner,
    chain: wallet.chain ?? null,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') {
    process.stderr.write(
      `leash revoke: tx ${txHash} reverted — the session key may already be uninstalled.\n`,
    );
    return 1;
  }

  process.stdout.write(
    `  ✓ revoked. tx ${txHash} (block ${receipt.blockNumber}, ${receipt.gasUsed} gas)\n` +
      `\n` +
      `The agent can no longer sign. Any in-flight UserOps will fail at validation.\n`,
  );
  return 0;
}
