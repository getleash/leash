import { describe, expect, it, vi } from 'vitest';
import { encodeEventTopics, encodeAbiParameters, keccak256, toBytes } from 'viem';
import { entryPointAbi } from '@getleash/core';
import { parseUserOpEvent, submitUserOp } from '../src/submit.js';

const ENTRYPOINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const SUB = '0x6bD660201f64De3064D94Be02D3EaFb5978F2022';
const PAYMASTER = '0x0000000000000000000000000000000000000000';
const USER_OP_HASH = ('0x' + 'cd'.repeat(32)) as `0x${string}`;

/** Construct a UserOperationEvent log entry suitable for parseUserOpEvent. */
function makeUserOpLog(params: {
  userOpHash: `0x${string}`;
  sender: `0x${string}`;
  paymaster: `0x${string}`;
  nonce: bigint;
  success: boolean;
  actualGasCost: bigint;
  actualGasUsed: bigint;
}) {
  // UserOperationEvent(bytes32 indexed userOpHash, address indexed sender,
  //                    address indexed paymaster, uint256 nonce, bool success,
  //                    uint256 actualGasCost, uint256 actualGasUsed)
  const topics = encodeEventTopics({
    abi: entryPointAbi,
    eventName: 'UserOperationEvent',
    args: {
      userOpHash: params.userOpHash,
      sender: params.sender,
      paymaster: params.paymaster,
    },
  });
  const data = encodeAbiParameters(
    [
      { type: 'uint256' },
      { type: 'bool' },
      { type: 'uint256' },
      { type: 'uint256' },
    ],
    [params.nonce, params.success, params.actualGasCost, params.actualGasUsed],
  );
  return {
    address: ENTRYPOINT as `0x${string}`,
    topics,
    data,
    blockHash: '0x' + '00'.repeat(32),
    blockNumber: 1n,
    logIndex: 0,
    removed: false,
    transactionHash: '0x' + '00'.repeat(32),
    transactionIndex: 0,
  } as any;
}

describe('parseUserOpEvent', () => {
  it('decodes a UserOperationEvent', () => {
    const log = makeUserOpLog({
      userOpHash: USER_OP_HASH,
      sender: SUB,
      paymaster: PAYMASTER,
      nonce: 42n,
      success: true,
      actualGasCost: 1_000_000_000_000n,
      actualGasUsed: 160_299n,
    });
    const parsed = parseUserOpEvent([log], ENTRYPOINT);
    expect(parsed).toBeDefined();
    expect(parsed!.userOpHash).toBe(USER_OP_HASH);
    expect(parsed!.sender.toLowerCase()).toBe(SUB.toLowerCase());
    expect(parsed!.nonce).toBe(42n);
    expect(parsed!.success).toBe(true);
    expect(parsed!.actualGasUsed).toBe(160_299n);
    expect(parsed!.actualGasCost).toBe(1_000_000_000_000n);
  });

  it('returns undefined when no matching event is present', () => {
    expect(parseUserOpEvent([], ENTRYPOINT)).toBeUndefined();
  });

  it('ignores logs from other contracts', () => {
    const log = makeUserOpLog({
      userOpHash: USER_OP_HASH,
      sender: SUB,
      paymaster: PAYMASTER,
      nonce: 0n,
      success: true,
      actualGasCost: 0n,
      actualGasUsed: 0n,
    });
    log.address = '0x0000000000000000000000000000000000000999';
    expect(parseUserOpEvent([log], ENTRYPOINT)).toBeUndefined();
  });
});

describe('submitUserOp', () => {
  const op: any = {
    sender: SUB,
    nonce: 0n,
    initCode: '0x',
    callData: '0x',
    accountGasLimits: '0x' + '00'.repeat(32),
    preVerificationGas: 0n,
    gasFees: '0x' + '00'.repeat(32),
    paymasterAndData: '0x',
    signature: '0x' + 'ab'.repeat(65),
  };
  const TX_HASH = ('0x' + '11'.repeat(32)) as `0x${string}`;

  function mockWallet(account = {
    address: '0x0000000000000000000000000000000000000bbb' as `0x${string}`,
  }) {
    return {
      account,
      chain: null,
      writeContract: vi.fn().mockResolvedValue(TX_HASH),
    } as any;
  }

  it('submits handleOps and returns the parsed UserOperationEvent on success', async () => {
    const wallet = mockWallet();
    const log = makeUserOpLog({
      userOpHash: USER_OP_HASH,
      sender: SUB,
      paymaster: PAYMASTER,
      nonce: 0n,
      success: true,
      actualGasCost: 2n,
      actualGasUsed: 160_000n,
    });
    const publicClient: any = {
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        logs: [log],
        blockNumber: 99n,
      }),
    };

    const res = await submitUserOp({
      userOp: op,
      entryPoint: ENTRYPOINT,
      bundlerWallet: wallet,
      publicClient,
    });

    expect(res.success).toBe(true);
    expect(res.txHash).toBe(TX_HASH);
    expect(res.userOpHash).toBe(USER_OP_HASH);
    expect(res.actualGasUsed).toBe(160_000n);
    expect(res.error).toBeUndefined();

    // Default beneficiary is the bundler's own address.
    const writeArgs = wallet.writeContract.mock.calls[0][0];
    expect(writeArgs.args[1]).toBe(wallet.account.address);
  });

  it('reports failure when the inner UserOp reverted (tx still succeeded)', async () => {
    const wallet = mockWallet();
    const log = makeUserOpLog({
      userOpHash: USER_OP_HASH,
      sender: SUB,
      paymaster: PAYMASTER,
      nonce: 0n,
      success: false,
      actualGasCost: 2n,
      actualGasUsed: 50_000n,
    });
    const publicClient: any = {
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        logs: [log],
        blockNumber: 100n,
      }),
    };
    const res = await submitUserOp({
      userOp: op,
      entryPoint: ENTRYPOINT,
      bundlerWallet: wallet,
      publicClient,
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/UserOp execution reverted/);
  });

  it('reports failure when handleOps itself reverted', async () => {
    const wallet = mockWallet();
    const publicClient: any = {
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: 'reverted',
        logs: [],
        blockNumber: 101n,
      }),
    };
    const res = await submitUserOp({
      userOp: op,
      entryPoint: ENTRYPOINT,
      bundlerWallet: wallet,
      publicClient,
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/handleOps transaction reverted/);
    expect(res.txHash).toBe(TX_HASH);
  });

  it('honors an explicit beneficiary', async () => {
    const wallet = mockWallet();
    const log = makeUserOpLog({
      userOpHash: USER_OP_HASH,
      sender: SUB,
      paymaster: PAYMASTER,
      nonce: 0n,
      success: true,
      actualGasCost: 0n,
      actualGasUsed: 0n,
    });
    const publicClient: any = {
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        logs: [log],
        blockNumber: 102n,
      }),
    };
    const beneficiary = '0x0000000000000000000000000000000000000ccc' as const;
    await submitUserOp({
      userOp: op,
      entryPoint: ENTRYPOINT,
      bundlerWallet: wallet,
      publicClient,
      beneficiary,
    });
    expect(wallet.writeContract.mock.calls[0][0].args[1]).toBe(beneficiary);
  });
});
