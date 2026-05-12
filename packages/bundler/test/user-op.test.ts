import { describe, expect, it, vi } from 'vitest';
import { encodeFunctionData } from 'viem';
import { erc20Abi, kernelAbi } from '@getleash/core';
import {
  buildUnsignedUserOp,
  encodeSingleExecute,
  getUserOpHash,
} from '../src/user-op.js';
import { encodeKernelNonceKey } from '../src/nonce.js';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ENTRYPOINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
const VALIDATOR = '0x224c21cc0F38AE4251d2E0a5a8c40fE19A615c9D';
const SUB = '0x6bD660201f64De3064D94Be02D3EaFb5978F2022';
const TO = '0x271189c860DB25bC43173B0335784aD68a680908';

describe('encodeSingleExecute', () => {
  it('produces Kernel.execute(mode, packed data) calldata', () => {
    const innerCallData = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [TO, 10_000n],
    });
    const callData = encodeSingleExecute({
      target: USDC,
      value: 0n,
      innerCallData,
    });

    // Starts with Kernel.execute's selector.
    const execSel = encodeFunctionData({
      abi: kernelAbi,
      functionName: 'execute',
      args: [
        '0x0000000000000000000000000000000000000000000000000000000000000000',
        '0x',
      ],
    }).slice(0, 10);
    expect(callData.slice(0, 10)).toBe(execSel);

    // The packed execute data must contain the target address byte-for-byte.
    expect(callData.toLowerCase()).toContain(USDC.toLowerCase().slice(2));
    // And the inner selector for transfer().
    expect(callData).toContain(innerCallData.slice(2));
  });
});

describe('buildUnsignedUserOp', () => {
  function mockClient(seq: bigint) {
    return {
      readContract: vi.fn().mockImplementation(async ({ functionName }: any) => {
        if (functionName === 'getNonce') return seq;
        throw new Error(`unexpected call: ${functionName}`);
      }),
      estimateFeesPerGas: vi.fn().mockResolvedValue({
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      }),
    } as any;
  }

  it('reads EntryPoint.getNonce with the Kernel-shaped key and packs the full nonce', async () => {
    const publicClient = mockClient(5n);
    const op = await buildUnsignedUserOp({
      sender: SUB,
      validator: VALIDATOR,
      entryPoint: ENTRYPOINT,
      callData: '0xdeadbeef',
      publicClient,
    });

    const expectedKey = encodeKernelNonceKey({ validator: VALIDATOR });
    expect(op.nonce).toBe((expectedKey << 64n) | 5n);

    // Also confirm we called getNonce with the expected key.
    const call = publicClient.readContract.mock.calls.find(
      (c: any) => c[0].functionName === 'getNonce',
    );
    expect(call[0].args).toEqual([SUB, expectedKey]);
  });

  it('leaves signature empty and defaults paymasterAndData/initCode to 0x', async () => {
    const op = await buildUnsignedUserOp({
      sender: SUB,
      validator: VALIDATOR,
      entryPoint: ENTRYPOINT,
      callData: '0xdeadbeef',
      publicClient: mockClient(0n),
    });
    expect(op.signature).toBe('0x');
    expect(op.paymasterAndData).toBe('0x');
    expect(op.initCode).toBe('0x');
  });

  it('honors explicit gas overrides', async () => {
    const op = await buildUnsignedUserOp({
      sender: SUB,
      validator: VALIDATOR,
      entryPoint: ENTRYPOINT,
      callData: '0xdeadbeef',
      publicClient: mockClient(0n),
      gas: {
        verificationGasLimit: 600_000n,
        callGasLimit: 250_000n,
        preVerificationGas: 120_000n,
        maxFeePerGas: 3_000_000_000n,
        maxPriorityFeePerGas: 1_500_000_000n,
      },
    });
    expect(op.preVerificationGas).toBe(120_000n);
    // Packed (hi, lo) — verification, call.
    expect(op.accountGasLimits).toMatch(
      /^0x000000000000000000000000000927c0/i, // 600_000 = 0x927c0
    );
    expect(op.accountGasLimits.toLowerCase()).toContain('3d090'); // 250_000 = 0x3d090
  });

  it('falls back to 1 gwei fees when estimateFeesPerGas throws', async () => {
    const failingClient: any = {
      readContract: vi.fn().mockResolvedValue(0n),
      estimateFeesPerGas: vi.fn().mockRejectedValue(new Error('rpc down')),
    };
    const op = await buildUnsignedUserOp({
      sender: SUB,
      validator: VALIDATOR,
      entryPoint: ENTRYPOINT,
      callData: '0x',
      publicClient: failingClient,
    });
    // 1 gwei == 0x3b9aca00 — expect both priority and max to contain that.
    expect(op.gasFees.toLowerCase()).toContain('3b9aca00');
  });
});

describe('getUserOpHash', () => {
  it('forwards to EntryPoint.getUserOpHash', async () => {
    const client: any = {
      readContract: vi.fn().mockResolvedValue('0x' + 'ab'.repeat(32)),
    };
    const h = await getUserOpHash(client, ENTRYPOINT, {
      sender: SUB,
      nonce: 0n,
      initCode: '0x',
      callData: '0x',
      accountGasLimits: ('0x' + '00'.repeat(32)) as `0x${string}`,
      preVerificationGas: 0n,
      gasFees: ('0x' + '00'.repeat(32)) as `0x${string}`,
      paymasterAndData: '0x',
      signature: '0x',
    });
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(client.readContract).toHaveBeenCalledOnce();
  });
});
