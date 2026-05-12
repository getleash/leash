import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type Address,
  type Chain,
  type Hex,
  type WalletClient,
  type PublicClient,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  formatEther,
  http,
  keccak256,
  toBytes,
  toFunctionSelector,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  erc20Abi,
  formatUsdc,
  getChainConfig,
  hashPolicyMarkdown,
  kernelAbi,
  leashFactoryAbi,
  mintGrantId,
  parsePolicy,
  resolveUpstreamPayTo,
  signAuthorizationGrant,
  type AgentPolicy,
  type AuthorizationGrant,
  type ChainConfig,
} from '@getleash/core';
import { pickSessionKeyStore, KeychainSessionKeyStore, FileSessionKeyStore } from '../stores/index.js';

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

// ─── leash apply <policy>.md ─────────────────────────────────────────
//
// The heaviest CLI command. Three distinct operating modes keyed off
// on-disk state:
//
//   1. FIRST RUN      — no .leash/config.json. Generate hub owner
//                       key, compute the counterfactual hub address,
//                       write a partial config, print funding
//                       instructions, exit 0.
//
//   2. FUNDED RUN     — config.json exists but no grant.json for the
//                       agent. Deploy hub + sub via LeashFactory,
//                       install SessionKeyValidator (direct tx from
//                       the hub owner — see Kernel's
//                       onlyEntryPointOrSelfOrRoot + ECDSAValidator
//                       preCheck hook), mint + sign an
//                       AuthorizationGrant, seed the sub with
//                       initial_funding USDC, write .mcp.json, exit 0.
//
//   3. ALREADY APPLIED — grant.json exists. Print the current state
//                        and exit 0. Rotation (swap session key,
//                        re-sign grant) is deliberately deferred —
//                        it's a `leash apply --rotate` flag that
//                        lands post-MVP.
//
// No paymaster involvement anywhere in apply — the factory deploys
// are regular txs paid by the hub owner, and the validator install
// runs as a direct Kernel call (root-hook path), not a UserOp.
// Phase 8 deploys the VerifyingPaymaster + flips transfer/fund/drain
// to sponsored gas; apply itself stays gas-from-owner indefinitely.

const KERNEL_EXECUTE_SELECTOR = toFunctionSelector('execute(bytes32,bytes)');
const MODULE_TYPE_VALIDATOR = 1n;
const MIN_HUB_ETH_WEI = 3_000_000_000_000_000n; // 0.003 ETH — Base L2 floor (~75× headroom at typical gas; ~5× at a 1 gwei spike)

interface HubConfigOnDisk {
  owner: Address;
  hub: Address;
  chain: AgentPolicy['chain'];
}

export async function apply(args: string[]): Promise<number> {
  const policyPath = args[0];
  if (!policyPath) {
    process.stderr.write(
      [
        'leash apply: missing policy path.',
        '',
        'Usage: leash apply <policy>.md',
      ].join('\n') + '\n',
    );
    return 2;
  }

  let policyText: string;
  try {
    policyText = readFileSync(resolve(policyPath), 'utf8');
  } catch (e) {
    process.stderr.write(
      `leash apply: cannot read ${policyPath}: ${(e as Error).message}\n`,
    );
    return 2;
  }

  let policy: AgentPolicy;
  try {
    policy = parsePolicy(policyText);
  } catch (e) {
    process.stderr.write(
      `Parse error in ${policyPath}: ${(e as Error).message}\n`,
    );
    return 2;
  }

  const chainConfig = getChainConfig(policy.chain);
  if (chainConfig.leashFactory === ZERO_ADDRESS) {
    process.stderr.write(
      `leash apply: LeashFactory not yet deployed on ${policy.chain}. ` +
        `Wait for the deployment and re-run.\n`,
    );
    return 1;
  }

  const cwd = process.cwd();
  const leashRoot = resolve(cwd, '.leash');
  const agentDir = resolve(leashRoot, 'agent', policy.name);
  const configPath = resolve(leashRoot, 'config.json');
  const grantPath = resolve(agentDir, 'grant.json');

  const resolvedPolicyPath = resolve(policyPath);

  // State machine.
  if (!existsSync(configPath)) {
    return firstRun({ policy, policyPath: resolvedPolicyPath, chainConfig, leashRoot, cwd });
  }
  if (!existsSync(grantPath)) {
    return fundedRun({
      policy,
      policyText,
      policyPath: resolvedPolicyPath,
      chainConfig,
      leashRoot,
      agentDir,
      cwd,
    });
  }
  return alreadyApplied({ policy, leashRoot, agentDir });
}

// ─── First run ───────────────────────────────────────────────────────

async function firstRun(p: {
  policy: AgentPolicy;
  policyPath: string;
  chainConfig: ChainConfig;
  leashRoot: string;
  cwd: string;
}): Promise<number> {
  mkdirSync(resolve(p.leashRoot, 'agent', p.policy.name), { recursive: true });

  const sessionKeys = pickSessionKeyStore({ leashRoot: p.leashRoot });

  // Hub-owner key provisioning. Two modes — we detect which:
  //   (a) RESUME: the store already has a hub-owner entry. Use it.
  //       This is the flow for operators who pre-seeded their
  //       preferred key (e.g. via `cast wallet new` + the Keychain
  //       seed command in summary/deploy.md §0.3), so that the
  //       paymaster's verifyingSigner set at deploy time matches
  //       the key this command will later use to sign sponsorships.
  //   (b) GENERATE: no entry yet. Mint a fresh secp256k1 keypair
  //       and persist it.
  //
  // Making this idempotent (never overwriting an existing entry)
  // is important because Keychain is per-user-global on macOS —
  // running `leash apply` in a second directory would otherwise
  // silently replace the first directory's key.
  let ownerAddress: Address;
  let hubOwnerSource: 'existing' | 'generated';
  try {
    const existing = sessionKeys.loadHubOwnerKey();
    ownerAddress = existing.address;
    hubOwnerSource = 'existing';
  } catch {
    const ownerPk = generatePrivateKey();
    const owner = privateKeyToAccount(ownerPk);
    writeHubOwnerKey(sessionKeys, p.leashRoot, owner.address, ownerPk);
    ownerAddress = owner.address;
    hubOwnerSource = 'generated';
  }

  const publicClient = makePublicClient(p.chainConfig);
  const hub = (await publicClient.readContract({
    address: p.chainConfig.leashFactory,
    abi: leashFactoryAbi,
    functionName: 'computeHubAddress',
    args: [ownerAddress],
  })) as Address;

  const config: HubConfigOnDisk = {
    owner: ownerAddress,
    hub,
    chain: p.policy.chain,
  };
  writeFileSync(
    resolve(p.leashRoot, 'config.json'),
    JSON.stringify(config, null, 2),
  );

  const keyStoreName =
    sessionKeys instanceof KeychainSessionKeyStore
      ? 'macOS Keychain'
      : 'the file store (.leash/hub-owner.json)';
  const keyLine =
    hubOwnerSource === 'generated'
      ? [
          '  ✓ Generated a new hub owner key (secp256k1).',
          `  ✓ Stored the private key via ${keyStoreName}.`,
        ]
      : [
          `  ✓ Using pre-seeded hub owner key from ${keyStoreName}:`,
          `      ${ownerAddress}`,
        ];

  // The sub-account's counterfactual address can't be computed yet —
  // LeashFactory.computeSubAccountAddress reads `ownerOfHub[hub]`, which
  // is zero until deployHub() lands. We print that address after the
  // hub deploy on the funded rerun, so the user sees both at that
  // moment.
  process.stdout.write(
    [
      `leash apply: first run for agent '${p.policy.name}' on ${p.policy.chain}.`,
      '',
      ...keyLine,
      `  ✓ Wrote .leash/config.json.`,
      '',
      '  Your hub address (counterfactual — not yet deployed on-chain):',
      '',
      `      ${hub}`,
      '',
      '  Fund it:',
      `    • ~5 USDC for agent operations`,
      `    • ~0.003 ETH for gas (the hub pays its own deploy + session-key install)`,
      '',
      `  Both on Base mainnet (chainId ${p.chainConfig.chainId}).`,
      `  USDC contract: ${p.chainConfig.usdc}.`,
      '',
      `  Then rerun \`leash apply ${p.policyPath}\` to complete setup.`,
    ].join('\n') + '\n',
  );
  return 0;
}

// ─── Funded run ──────────────────────────────────────────────────────

async function fundedRun(p: {
  policy: AgentPolicy;
  policyText: string;
  policyPath: string;
  chainConfig: ChainConfig;
  leashRoot: string;
  agentDir: string;
  cwd: string;
}): Promise<number> {
  mkdirSync(p.agentDir, { recursive: true });

  const config = readJson<HubConfigOnDisk>(resolve(p.leashRoot, 'config.json'));
  if (config.chain !== p.policy.chain) {
    process.stderr.write(
      `leash apply: policy chain '${p.policy.chain}' does not match ` +
        `.leash/config.json chain '${config.chain}'. ` +
        `Either fix the policy or re-init .leash/ with the correct chain.\n`,
    );
    return 1;
  }

  const sessionKeys = pickSessionKeyStore({ leashRoot: p.leashRoot });
  const hubOwner = sessionKeys.loadHubOwnerKey();
  if (hubOwner.address.toLowerCase() !== config.owner.toLowerCase()) {
    process.stderr.write(
      `leash apply: hub-owner key derives to ${hubOwner.address}, ` +
        `config.owner is ${config.owner}. Key store out of sync with config.\n`,
    );
    return 1;
  }

  const publicClient = makePublicClient(p.chainConfig);
  const walletClient = createWalletClient({
    chain: p.chainConfig.chain as Chain,
    transport: http(resolveRpc(p.chainConfig)),
    account: hubOwner,
  });

  // ── Pre-flight: balances on the counterfactual hub ────────────
  const hubEth = await publicClient.getBalance({ address: config.hub });
  if (hubEth < MIN_HUB_ETH_WEI) {
    process.stderr.write(
      `leash apply: hub ${config.hub} has ${formatEther(hubEth)} ETH — ` +
        `need at least ${formatEther(MIN_HUB_ETH_WEI)} ETH for deploy + session-key install gas. ` +
        `Send more ETH to the hub and rerun.\n`,
    );
    return 1;
  }
  const hubUsdc = (await publicClient.readContract({
    address: p.chainConfig.usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [config.hub],
  })) as bigint;
  if (hubUsdc < p.policy.initialFunding) {
    process.stderr.write(
      `leash apply: hub has ${formatUsdc(hubUsdc)} USDC, ` +
        `policy.initial_funding is ${formatUsdc(p.policy.initialFunding)}. ` +
        `Fund the hub and rerun.\n`,
    );
    return 1;
  }

  process.stdout.write(
    `leash apply: funding confirmed. Proceeding with deploy for '${p.policy.name}' on ${p.policy.chain}.\n`,
  );

  // ── Deploy hub (idempotent — checks hubOf first) ──────────────
  const existingHub = (await publicClient.readContract({
    address: p.chainConfig.leashFactory,
    abi: leashFactoryAbi,
    functionName: 'hubOf',
    args: [hubOwner.address],
  })) as Address;

  if (existingHub === ZERO_ADDRESS) {
    await writeTx(walletClient, publicClient, {
      label: 'deploy hub',
      address: p.chainConfig.leashFactory,
      abi: leashFactoryAbi,
      functionName: 'deployHub',
      args: [],
      account: hubOwner,
    });
    await waitForVisible(
      () =>
        publicClient.readContract({
          address: p.chainConfig.leashFactory,
          abi: leashFactoryAbi,
          functionName: 'hubOf',
          args: [hubOwner.address],
        }) as Promise<Address>,
      (seen) => seen !== ZERO_ADDRESS,
      { timeoutMs: 30_000, intervalMs: 1500, description: 'hub deploy' },
    );
  } else if (existingHub.toLowerCase() !== config.hub.toLowerCase()) {
    process.stderr.write(
      `leash apply: on-chain hubOf[owner] is ${existingHub} but config.hub is ${config.hub}. ` +
        `Config is stale — delete .leash/ and restart.\n`,
    );
    return 1;
  } else {
    process.stdout.write(`  ✓ hub already deployed at ${config.hub}\n`);
  }

  // ── Deploy sub (idempotent) ───────────────────────────────────
  const existingSub = (await publicClient.readContract({
    address: p.chainConfig.leashFactory,
    abi: leashFactoryAbi,
    functionName: 'subOf',
    args: [config.hub, keccakString(p.policy.name)],
  })) as Address;

  let subAccount: Address;
  if (existingSub === ZERO_ADDRESS) {
    await writeTx(walletClient, publicClient, {
      label: `deploy sub-account '${p.policy.name}'`,
      address: p.chainConfig.leashFactory,
      abi: leashFactoryAbi,
      functionName: 'deploySubAccount',
      args: [p.policy.name],
      account: hubOwner,
    });
    subAccount = await waitForVisible(
      () =>
        publicClient.readContract({
          address: p.chainConfig.leashFactory,
          abi: leashFactoryAbi,
          functionName: 'subOf',
          args: [config.hub, keccakString(p.policy.name)],
        }) as Promise<Address>,
      (seen) => seen !== ZERO_ADDRESS,
      { timeoutMs: 30_000, intervalMs: 1500, description: 'sub-account deploy' },
    );
  } else {
    subAccount = existingSub;
    process.stdout.write(`  ✓ sub-account already deployed at ${subAccount}\n`);
  }

  process.stdout.write(
    `  ✓ hub:         ${config.hub}\n` +
      `  ✓ sub-account: ${subAccount}  ← agent operations happen here\n`,
  );

  // ── Generate or reuse session key + install SessionKeyValidator ────
  //
  // On retry after a partial first attempt, reuse the previously-
  // persisted session key — generating a fresh one here would orphan
  // the validator install on chain (it's bound to the old key) and
  // break 1271 sigs from the agent.
  let sessionKey: ReturnType<typeof privateKeyToAccount>;
  try {
    sessionKey = sessionKeys.loadAgentKey(p.policy.name);
  } catch {
    const sessionKeyPk = generatePrivateKey();
    sessionKey = privateKeyToAccount(sessionKeyPk);
    writeAgentSessionKey(
      sessionKeys,
      p.leashRoot,
      p.policy.name,
      sessionKey.address,
      sessionKeyPk,
    );
  }

  const validUntilSec = Math.floor(Date.now() / 1000) + p.policy.validityDays * 86_400;

  // Skip install if Kernel already has SessionKeyValidator wired —
  // the previous run installed it for this same session key (we
  // reused it from the store above).
  const validatorInstalled = (await publicClient.readContract({
    address: subAccount,
    abi: kernelAbi,
    functionName: 'isModuleInstalled',
    args: [MODULE_TYPE_VALIDATOR, p.chainConfig.sessionKeyValidator, '0x' as Hex],
  })) as boolean;

  if (!validatorInstalled) {
    const { recipients, recipientCaps } = resolveUpstreamRecipients(p.policy);
    await writeTx(walletClient, publicClient, {
      label: 'install SessionKeyValidator',
      address: subAccount,
      abi: kernelAbi,
      functionName: 'installModule',
      args: [
        MODULE_TYPE_VALIDATOR,
        p.chainConfig.sessionKeyValidator,
        buildInstallInitData({
          signer: sessionKey.address,
          validUntil: validUntilSec,
          maxValuePerTx: 0n, // no native-value calls in MVP policies
          targets: [p.chainConfig.usdc],
          selectors: [
            toFunctionSelector('transfer(address,uint256)'),
          ],
          recipients,
          recipientCaps,
        }),
      ],
      account: hubOwner,
    });
  } else {
    process.stdout.write(
      `  ✓ SessionKeyValidator already installed on sub-account\n`,
    );
  }

  // ── Seed the sub with initial_funding USDC (direct Kernel.execute) ──
  // Skip if the sub already holds at least initial_funding — covers
  // the "previous run installed the validator but died on the seed"
  // case and any post-install top-ups.
  if (p.policy.initialFunding > 0n) {
    const subUsdc = (await publicClient.readContract({
      address: p.chainConfig.usdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [subAccount],
    })) as bigint;
    if (subUsdc >= p.policy.initialFunding) {
      process.stdout.write(
        `  ✓ sub already holds ${formatUsdc(subUsdc)} USDC (≥ initial_funding ${formatUsdc(p.policy.initialFunding)}); skipping seed\n`,
      );
    } else {
      const innerCalldata = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [subAccount, p.policy.initialFunding],
      });
      const execData = encodePacked(
        ['address', 'uint256', 'bytes'],
        [p.chainConfig.usdc, 0n, innerCalldata],
      );
      // CALLTYPE_SINGLE + default exec — 32 zero bytes. Matches
      // @getleash/bundler/src/user-op.ts::KERNEL_EXEC_MODE_SINGLE_DEFAULT.
      const mode = ('0x' + '00'.repeat(32)) as Hex;
      await writeTx(walletClient, publicClient, {
        label: `seed sub with ${formatUsdc(p.policy.initialFunding)} USDC`,
        address: config.hub,
        abi: kernelAbi,
        functionName: 'execute',
        args: [mode, execData],
        account: hubOwner,
      });
    }
  }

  // ── Build + sign + write AuthorizationGrant ──────────────────
  const grantId = mintGrantId();
  const grant: AuthorizationGrant = {
    id: grantId,
    principal: hubOwner.address,
    agent: sessionKey.address,
    subAccount,
    chain: p.policy.chain,
    validFrom: Math.floor(Date.now() / 1000),
    validUntil: validUntilSec,
    purpose: purposeFromPolicy(p.policy),
    limits: p.policy.limits,
    upstreams: p.policy.upstreams,
    counterparties: p.policy.counterparties,
    policyHash: hashPolicyMarkdown(p.policyText),
  };
  const signed = await signAuthorizationGrant(grant, hubOwner);

  writeFileSync(
    resolve(p.agentDir, 'agent.json'),
    JSON.stringify(
      {
        name: p.policy.name,
        subAccount,
        sessionKey: sessionKey.address,
        policyPath: p.policyPath,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    resolve(p.agentDir, 'grant.json'),
    JSON.stringify(
      signed,
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      2,
    ),
  );
  // Copy the policy markdown alongside so its content matches
  // grant.policyHash — guards against later drift on disk.
  writeFileSync(resolve(p.agentDir, 'policy.md'), p.policyText);

  // ── Write .mcp.json at the repo root ──────────────────────────
  writeMcpJson(p.cwd, p.policy.name);

  process.stdout.write(
    [
      '',
      `  ✓ session key:      ${sessionKey.address}`,
      `  ✓ grant ${grantId}`,
      `  ✓ expires           ${new Date(validUntilSec * 1000).toISOString()}`,
      `  ✓ wrote .mcp.json at ${p.cwd}`,
      '',
      `Open Claude Code in this directory — Leash is wired for '${p.policy.name}'.`,
    ].join('\n') + '\n',
  );
  return 0;
}

// ─── Already applied ─────────────────────────────────────────────────

async function alreadyApplied(p: {
  policy: AgentPolicy;
  leashRoot: string;
  agentDir: string;
}): Promise<number> {
  const grantJson = readJson<{
    grant: { id: string; subAccount: Address; validUntil: number };
  }>(resolve(p.agentDir, 'grant.json'));
  const nowSec = Math.floor(Date.now() / 1000);
  const expired = nowSec > grantJson.grant.validUntil;
  process.stdout.write(
    [
      `leash apply: agent '${p.policy.name}' is already applied.`,
      `  grant ${grantJson.grant.id}`,
      `  sub-account ${grantJson.grant.subAccount}`,
      `  expires ${new Date(grantJson.grant.validUntil * 1000).toISOString()}` +
        (expired ? '  (EXPIRED)' : ''),
      '',
      expired
        ? '  Rotation support (`leash apply --rotate`) lands post-MVP. For now, revoke and re-apply:'
        : '  To rotate the session key before expiry, revoke then re-apply:',
      `    leash revoke ${p.policy.name}`,
      `    # (then delete .leash/agent/${p.policy.name}/grant.json and rerun leash apply)`,
    ].join('\n') + '\n',
  );
  return 0;
}

// ─── helpers ─────────────────────────────────────────────────────────

function makePublicClient(chainConfig: ChainConfig): PublicClient {
  return createPublicClient({
    chain: chainConfig.chain as Chain,
    transport: http(resolveRpc(chainConfig)),
  });
}

function resolveRpc(chainConfig: ChainConfig): string {
  const env =
    chainConfig.name === 'base'
      ? process.env.LEASH_BASE_RPC
      : process.env.LEASH_BASE_SEPOLIA_RPC;
  return env ?? (chainConfig.name === 'base'
    ? 'https://mainnet.base.org'
    : 'https://sepolia.base.org');
}

async function writeTx(
  wallet: WalletClient,
  publicClient: PublicClient,
  args: {
    label: string;
    address: Address;
    abi: any;
    functionName: string;
    args: unknown[];
    account: ReturnType<typeof privateKeyToAccount>;
  },
): Promise<void> {
  process.stdout.write(`  → ${args.label}…\n`);
  const txHash = await wallet.writeContract({
    address: args.address,
    abi: args.abi,
    functionName: args.functionName,
    args: args.args as any,
    account: args.account,
    chain: wallet.chain ?? null,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') {
    throw new Error(`${args.label}: tx ${txHash} reverted`);
  }
  process.stdout.write(`    tx ${txHash} (block ${receipt.blockNumber})\n`);
}

// Public RPCs (sepolia.base.org, mainnet.base.org) are load-balanced
// across many backing nodes, so the read immediately after a
// confirmed write can land on a node that hasn't ingested the new
// block yet — the contract reverts the next call with e.g.
// HubNotDeployed even though the deploy already succeeded. Poll the
// post-state on the load-balanced read path until it's visible.
//
// Errors during the poll (rate limits, transient 5xx, momentarily-
// stale node responses) are absorbed and retried within the same
// timeout budget; the last error surfaces in the timeout message so
// the operator sees what actually went wrong. Default intervalMs is
// 1500 ms so we stay well under per-second throttle limits on public
// mainnet endpoints.
async function waitForVisible<T>(
  read: () => Promise<T>,
  visible: (v: T) => boolean,
  opts: { timeoutMs: number; intervalMs: number; description: string },
): Promise<T> {
  const start = Date.now();
  let lastError: unknown;
  while (true) {
    try {
      const v = await read();
      if (visible(v)) return v;
      lastError = undefined;
    } catch (e) {
      lastError = e;
    }
    if (Date.now() - start > opts.timeoutMs) {
      const tail = lastError
        ? `\n  Last RPC error: ${(lastError as Error).message?.split('\n')[0] ?? String(lastError)}`
        : '';
      throw new Error(
        `${opts.description}: post-state not visible after ` +
          `${(opts.timeoutMs / 1000).toFixed(0)}s — likely RPC node lag ` +
          `or rate limiting. Set LEASH_BASE_RPC / ` +
          `LEASH_BASE_SEPOLIA_RPC to a dedicated endpoint ` +
          `(Alchemy, QuickNode, Coinbase CDP, or self-hosted) and rerun.` +
          tail,
      );
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
}

function buildInstallInitData(p: {
  signer: Address;
  validUntil: number;
  maxValuePerTx: bigint;
  targets: Address[];
  selectors: Hex[];
  recipients: Address[];
  recipientCaps: bigint[];
}): Hex {
  // Matches LeashIntegration.t.sol::_installSessionKeyValidator (witness validator):
  //   validatorData = abi.encode(signer, validUntil, maxValuePerTx, targets, selectors,
  //                              recipients, recipientCaps)
  //   installFormat = abi.encode(validatorData, bytes(""), abi.encodePacked(Kernel.execute.selector))
  //   initData      = abi.encodePacked(bytes20(0), installFormat)
  const validatorData = encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'uint48' },
      { type: 'uint256' },
      { type: 'address[]' },
      { type: 'bytes4[]' },
      { type: 'address[]' },
      { type: 'uint256[]' },
    ],
    [
      p.signer,
      p.validUntil,
      p.maxValuePerTx,
      p.targets,
      p.selectors,
      p.recipients,
      p.recipientCaps,
    ],
  );
  const hookData: Hex = '0x';
  const selectorData = KERNEL_EXECUTE_SELECTOR;
  const installFormat = encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes' }, { type: 'bytes' }],
    [validatorData, hookData, selectorData],
  );
  const hookId: Hex = ('0x' + '00'.repeat(20)) as Hex; // bytes20(0)
  return (hookId + installFormat.slice(2)) as Hex;
}

/**
 * Build the x402-recipient allowlist that gets installed into the
 * SessionKeyValidator's `maxValueByRecipient` mapping. Each entry is one
 * upstream's `payTo` paired with the per-call cap: `upstream.maxPerCall`
 * if set in the policy, otherwise the policy's global
 * `limits.maxPerTransaction`. Unknown upstreams (no entry in
 * `UPSTREAM_PAYTO` for this chain) abort the install — better to fail
 * loud here than to silently leave a payment path unenforced.
 */
function resolveUpstreamRecipients(policy: AgentPolicy): {
  recipients: Address[];
  recipientCaps: bigint[];
} {
  // Multiple upstream namespaces can share a single payTo address — common
  // when one operator runs several services on the same settlement wallet
  // (the `0000402.xyz` family being the canonical example). Dedupe by
  // address with the max cap across all namespaces that share it; the
  // witness validator's `maxValueByRecipient[k][addr]` is per-recipient, not
  // per-namespace, so the highest declared cap wins on-chain. Off-chain
  // rolling caps remain per-namespace.
  const byAddress = new Map<string, bigint>();
  for (const u of policy.upstreams) {
    const payTo = resolveUpstreamPayTo(u.name, policy.chain);
    if (!payTo) {
      throw new Error(
        `Upstream "${u.name}" has no registered payTo for chain ${policy.chain}. ` +
          `Add it to packages/core/src/upstream-payto.ts or remove the upstream from the policy.`,
      );
    }
    const cap = u.maxPerCall ?? policy.limits.maxPerTransaction;
    const key = payTo.toLowerCase();
    const existing = byAddress.get(key);
    byAddress.set(key, existing !== undefined && existing > cap ? existing : cap);
  }
  const recipients = [...byAddress.keys()].map((k) => k as Address);
  const recipientCaps = recipients.map((r) => byAddress.get(r.toLowerCase())!);
  return { recipients, recipientCaps };
}

function writeHubOwnerKey(
  store: ReturnType<typeof pickSessionKeyStore>,
  leashRoot: string,
  address: Address,
  privateKey: Hex,
): void {
  if (store instanceof KeychainSessionKeyStore) {
    store.setHubOwnerKey(privateKey);
    return;
  }
  if (store instanceof FileSessionKeyStore) {
    // FileSessionKeyStore writes to .leash/hub-owner.json; write the
    // shape the reader expects.
    writeFileSync(
      resolve(leashRoot, 'hub-owner.json'),
      JSON.stringify({ privateKey, address }, null, 2),
    );
    return;
  }
  throw new Error('unsupported session-key store — cannot persist hub owner key');
}

function writeAgentSessionKey(
  store: ReturnType<typeof pickSessionKeyStore>,
  leashRoot: string,
  agentName: string,
  address: Address,
  privateKey: Hex,
): void {
  if (store instanceof KeychainSessionKeyStore) {
    store.setAgentKey(agentName, privateKey);
    return;
  }
  if (store instanceof FileSessionKeyStore) {
    writeFileSync(
      resolve(leashRoot, 'agent', agentName, 'session-key.json'),
      JSON.stringify({ privateKey, address }, null, 2),
    );
    return;
  }
  throw new Error('unsupported session-key store — cannot persist agent session key');
}

function writeMcpJson(cwd: string, agentName: string): void {
  writeFileSync(
    resolve(cwd, '.mcp.json'),
    JSON.stringify(
      {
        mcpServers: {
          leash: {
            command: 'leash',
            args: ['serve', agentName],
          },
        },
      },
      null,
      2,
    ),
  );
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function purposeFromPolicy(p: AgentPolicy): string {
  const upstreams = p.upstreams.map((u) => u.name).join(', ') || 'none';
  return `Pay ${upstreams} within policy limits for agent '${p.name}'.`;
}

// Matches LeashFactory's `keccak256(bytes(agentName))` used as the
// sub-account registry key — `abi.encodePacked(string)` in Solidity is
// just the UTF-8 bytes of the string.
function keccakString(s: string): Hex {
  return keccak256(toBytes(s));
}

function basename(_policyText: string, agentName: string): string {
  // Best-effort guess for the rerun hint. Falls back to <agent>-policy.md.
  return `${agentName}-policy.md`;
}
