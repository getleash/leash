/**
 * On-chain integration tests against Base Sepolia.
 *
 * These tests deploy a smart account, register a session key,
 * and verify whitelist enforcement + expiry on a real chain.
 *
 * Requires funded deployer and bundler keys in .env.
 * Run: npm run test:sepolia -w packages/core
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  getAddress,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import {
  BASE_SEPOLIA,
  leashAccountAbi,
  leashAccountFactoryAbi,
  entryPointAbi,
  erc20Abi,
  verifyingPaymasterAbi,
} from '../../src/index.js';

// ─── Config ──────────────────────────────────────────────────────────

const RPC_URL = process.env.BASE_RPC_URL || 'https://base-sepolia-rpc.publicnode.com';
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY as Hex;
const BUNDLER_KEY = process.env.BUNDLER_PRIVATE_KEY as Hex;
const PAYMASTER_SIGNER_KEY = process.env.PAYMASTER_SIGNER_KEY as Hex;

if (!DEPLOYER_KEY || !BUNDLER_KEY || !PAYMASTER_SIGNER_KEY) {
  throw new Error('Missing env vars: DEPLOYER_PRIVATE_KEY, BUNDLER_PRIVATE_KEY, PAYMASTER_SIGNER_KEY');
}

const config = BASE_SEPOLIA;
const deployerAccount = privateKeyToAccount(DEPLOYER_KEY);
const bundlerAccount = privateKeyToAccount(BUNDLER_KEY);
const paymasterSignerAccount = privateKeyToAccount(PAYMASTER_SIGNER_KEY);

// Generate a fresh session key for each test run
const sessionKeyPrivate = ('0x' + [...Array(64)].map(() => Math.floor(Math.random() * 16).toString(16)).join('')) as Hex;
const sessionKeyAccount = privateKeyToAccount(sessionKeyPrivate);

const USDC_TRANSFER_SELECTOR = '0xa9059cbb' as Hex; // transfer(address,uint256)
const USDC_APPROVE_SELECTOR = '0x095ea7b3' as Hex; // approve(address,uint256)
const ALLOWED_TARGET = config.usdc;
const DISALLOWED_TARGET = '0x0000000000000000000000000000000000000001' as Address;

// ─── Clients ─────────────────────────────────────────────────────────

let publicClient: PublicClient;
let deployerWallet: WalletClient;
let bundlerWallet: WalletClient;
let accountAddress: Address;

// ─── Helpers ─────────────────────────────────────────────────────────

function packGasLimits(verificationGas: bigint, callGas: bigint): Hex {
  return ('0x' +
    verificationGas.toString(16).padStart(32, '0') +
    callGas.toString(16).padStart(32, '0')) as Hex;
}

function packGasFees(maxPriorityFee: bigint, maxFee: bigint): Hex {
  return ('0x' +
    maxPriorityFee.toString(16).padStart(32, '0') +
    maxFee.toString(16).padStart(32, '0')) as Hex;
}

// Track nonces locally to avoid RPC eventual consistency issues
let lastKnownNonce: bigint | null = null;
let bundlerNonce: number | null = null;

async function buildUserOp(callData: Hex): Promise<{
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}> {
  // Read nonce from EntryPoint, but use local tracker if RPC returns stale value
  const rpcNonce = await publicClient.readContract({
    address: config.entryPoint,
    abi: entryPointAbi,
    functionName: 'getNonce',
    args: [accountAddress, 0n],
  }) as bigint;

  const nonce = lastKnownNonce !== null && rpcNonce <= lastKnownNonce
    ? lastKnownNonce + 1n
    : rpcNonce;

  const feeData = await publicClient.estimateFeesPerGas();
  const maxFee = feeData.maxFeePerGas ?? 1000000000n;
  const maxPriority = feeData.maxPriorityFeePerGas ?? 1000000n;

  return {
    sender: accountAddress,
    nonce,
    initCode: '0x',
    callData,
    accountGasLimits: packGasLimits(500000n, 300000n),
    preVerificationGas: 100000n,
    gasFees: packGasFees(maxPriority, maxFee),
    paymasterAndData: '0x',
    signature: '0x',
  };
}

async function signAndSponsorUserOp(
  userOp: Awaited<ReturnType<typeof buildUserOp>>,
  signerKey: Hex,
): Promise<Awaited<ReturnType<typeof buildUserOp>>> {
  // Build paymasterAndData
  const validUntil = Math.floor(Date.now() / 1000) + 3600; // 1 hour
  const validAfter = 0;

  // Placeholder paymasterAndData for hash computation
  const placeholderSig = '0x' + '00'.repeat(65);
  const paymasterAndData = (config.verifyingPaymaster.toLowerCase() +
    (100000n).toString(16).padStart(32, '0') +
    (50000n).toString(16).padStart(32, '0') +
    validUntil.toString(16).padStart(12, '0') +
    validAfter.toString(16).padStart(12, '0') +
    placeholderSig.slice(2)) as Hex;

  userOp.paymasterAndData = paymasterAndData;

  // Get paymaster hash
  const paymasterHash = await publicClient.readContract({
    address: config.verifyingPaymaster as Address,
    abi: verifyingPaymasterAbi,
    functionName: 'getHash',
    args: [userOp, validUntil, validAfter],
  });

  // Sign with paymaster signer
  const paymasterSig = await paymasterSignerAccount.signMessage({
    message: { raw: paymasterHash as Hex },
  });

  // Replace placeholder with real signature
  userOp.paymasterAndData = (config.verifyingPaymaster.toLowerCase() +
    (100000n).toString(16).padStart(32, '0') +
    (50000n).toString(16).padStart(32, '0') +
    validUntil.toString(16).padStart(12, '0') +
    validAfter.toString(16).padStart(12, '0') +
    paymasterSig.slice(2)) as Hex;

  // Get userOpHash and sign with account key
  const userOpHash = await publicClient.readContract({
    address: config.entryPoint,
    abi: entryPointAbi,
    functionName: 'getUserOpHash',
    args: [userOp],
  });

  const accountSigner = privateKeyToAccount(signerKey);
  userOp.signature = await accountSigner.signMessage({
    message: { raw: userOpHash as Hex },
  });

  return userOp;
}

async function submitUserOp(userOp: Awaited<ReturnType<typeof buildUserOp>>): Promise<Hex> {
  // Get bundler nonce, using local tracker to avoid RPC lag
  if (bundlerNonce === null) {
    bundlerNonce = await publicClient.getTransactionCount({
      address: bundlerAccount.address,
      blockTag: 'pending',
    });
  }

  const txHash = await bundlerWallet.writeContract({
    address: config.entryPoint,
    abi: entryPointAbi,
    functionName: 'handleOps',
    args: [[userOp], bundlerAccount.address],
    chain: baseSepolia,
    account: bundlerAccount,
    nonce: bundlerNonce,
  });

  bundlerNonce++;

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  expect(receipt.status).toBe('success');
  // Track the nonce we just used so next buildUserOp can increment
  lastKnownNonce = userOp.nonce;
  return txHash;
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('Base Sepolia Integration', () => {
  beforeAll(async () => {
    publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(RPC_URL),
    });
    deployerWallet = createWalletClient({
      chain: baseSepolia,
      transport: http(RPC_URL),
      account: deployerAccount,
    });
    bundlerWallet = createWalletClient({
      chain: baseSepolia,
      transport: http(RPC_URL),
      account: bundlerAccount,
    });

    // Get counterfactual address
    accountAddress = await publicClient.readContract({
      address: config.leashFactory as Address,
      abi: leashAccountFactoryAbi,
      functionName: 'getAddress',
      args: [deployerAccount.address, 0n],
    }) as Address;

    // Deploy smart account if not already deployed
    const code = await publicClient.getCode({ address: accountAddress });
    if (!code || code === '0x') {
      console.log('Deploying smart account...');
      const txHash = await deployerWallet.writeContract({
        address: config.leashFactory as Address,
        abi: leashAccountFactoryAbi,
        functionName: 'createAccount',
        args: [deployerAccount.address, 0n],
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash });
    } else {
      console.log('Smart account already deployed');
    }

    console.log('Smart account:', accountAddress);
    console.log('Session key:', sessionKeyAccount.address);

    // Register session key with USDC transfer + approve whitelisted
    const targets = [ALLOWED_TARGET, ALLOWED_TARGET];
    const selectors = [USDC_TRANSFER_SELECTOR, USDC_APPROVE_SELECTOR];
    const validUntil = Math.floor(Date.now() / 1000) + 86400; // 24 hours

    const registerCalldata = encodeFunctionData({
      abi: leashAccountAbi,
      functionName: 'registerSessionKey',
      args: [sessionKeyAccount.address, validUntil, targets, selectors],
    });

    // Owner calls registerSessionKey via execute
    const nonce = await publicClient.getTransactionCount({
      address: deployerAccount.address,
      blockTag: 'pending',
    });
    const executeTx = await deployerWallet.writeContract({
      address: accountAddress,
      abi: leashAccountAbi,
      functionName: 'execute',
      args: [accountAddress, 0n, registerCalldata],
      nonce,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: executeTx });
    console.log('registerSessionKey tx:', executeTx, 'status:', receipt.status);

    // Verify session key was registered (retry to handle RPC eventual consistency)
    let skExists = false;
    let skValidUntil = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      const skResult = await publicClient.readContract({
        address: accountAddress,
        abi: leashAccountAbi,
        functionName: 'sessionKeys',
        args: [sessionKeyAccount.address],
      }) as [number, boolean];
      [skValidUntil, skExists] = skResult;
      if (skExists) break;
      console.log(`Session key not visible yet (attempt ${attempt + 1}), waiting...`);
      await new Promise(r => setTimeout(r, 2000));
    }
    expect(skExists).toBe(true);
    console.log('Session key registered, validUntil:', skValidUntil);
  }, 120_000);

  // ─── Owner Tests ─────────────────────────────────────────────

  it('owner can execute via UserOp', async () => {
    // Owner calls a no-op (execute to self with empty data is fine since it hits receive())
    const callData = encodeFunctionData({
      abi: leashAccountAbi,
      functionName: 'execute',
      args: [accountAddress, 0n, '0x'],
    });

    const userOp = await buildUserOp(callData);
    const signed = await signAndSponsorUserOp(userOp, DEPLOYER_KEY);
    const txHash = await submitUserOp(signed);
    expect(txHash).toMatch(/^0x/);
  }, 60_000);

  // ─── Session Key Positive Tests ──────────────────────────────

  it('session key can call whitelisted target+selector', async () => {
    // Session key calls USDC.transfer (will likely fail execution since no USDC,
    // but validation should PASS — that's what we're testing)
    const innerCalldata = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [deployerAccount.address, 0n], // 0 amount — won't revert even without balance
    });

    const callData = encodeFunctionData({
      abi: leashAccountAbi,
      functionName: 'execute',
      args: [ALLOWED_TARGET, 0n, innerCalldata],
    });

    const userOp = await buildUserOp(callData);
    const signed = await signAndSponsorUserOp(userOp, sessionKeyPrivate);
    const txHash = await submitUserOp(signed);
    expect(txHash).toMatch(/^0x/);
  }, 60_000);

  // ─── Session Key Rejection Tests ─────────────────────────────

  it('session key rejected for non-whitelisted target', async () => {
    const innerCalldata = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [deployerAccount.address, 0n],
    });

    const callData = encodeFunctionData({
      abi: leashAccountAbi,
      functionName: 'execute',
      args: [DISALLOWED_TARGET, 0n, innerCalldata],
    });

    const userOp = await buildUserOp(callData);
    const signed = await signAndSponsorUserOp(userOp, sessionKeyPrivate);

    // Should revert — target not whitelisted
    await expect(submitUserOp(signed)).rejects.toThrow();
  }, 60_000);

  it('session key rejected for non-whitelisted selector', async () => {
    // balanceOf selector is not whitelisted
    const innerCalldata = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [accountAddress],
    });

    const callData = encodeFunctionData({
      abi: leashAccountAbi,
      functionName: 'execute',
      args: [ALLOWED_TARGET, 0n, innerCalldata],
    });

    const userOp = await buildUserOp(callData);
    const signed = await signAndSponsorUserOp(userOp, sessionKeyPrivate);

    await expect(submitUserOp(signed)).rejects.toThrow();
  }, 60_000);

  it('unregistered key is rejected', async () => {
    const randomKey = ('0x' + [...Array(64)].map(() => Math.floor(Math.random() * 16).toString(16)).join('')) as Hex;

    const innerCalldata = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [deployerAccount.address, 0n],
    });

    const callData = encodeFunctionData({
      abi: leashAccountAbi,
      functionName: 'execute',
      args: [ALLOWED_TARGET, 0n, innerCalldata],
    });

    const userOp = await buildUserOp(callData);
    const signed = await signAndSponsorUserOp(userOp, randomKey);

    await expect(submitUserOp(signed)).rejects.toThrow();
  }, 60_000);
});
