import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { PackedUserOperation } from '@getleash/core';
import { NO_PAYMASTER, sponsorUserOp } from '../src/paymaster.js';

const PAYMASTER = '0x00000000000000000000000000000000000000aa';
const VERIFYING_PK =
  '0x1111111111111111111111111111111111111111111111111111111111111111';

function makeOp(): PackedUserOperation {
  return {
    sender: '0x6bD660201f64De3064D94Be02D3EaFb5978F2022',
    nonce: 0n,
    initCode: '0x',
    callData: '0x',
    accountGasLimits: ('0x' + '00'.repeat(32)) as `0x${string}`,
    preVerificationGas: 100_000n,
    gasFees: ('0x' + '00'.repeat(32)) as `0x${string}`,
    paymasterAndData: '0x',
    signature: '0x',
  };
}

describe('sponsorUserOp', () => {
  const signer = privateKeyToAccount(VERIFYING_PK);
  const SPONSOR_HASH = '0x' + 'ab'.repeat(32);

  it('calls paymaster.getHash, signs the digest, and writes paymasterAndData', async () => {
    const publicClient: any = {
      readContract: vi.fn().mockResolvedValue(SPONSOR_HASH),
    };
    const op = makeOp();
    const validUntil = 2_000_000_000;
    const validAfter = 0;

    const blob = await sponsorUserOp({
      userOp: op,
      paymaster: PAYMASTER,
      publicClient,
      verifyingSigner: signer,
      validUntil,
      validAfter,
    });

    expect(blob).toBe(op.paymasterAndData);
    // paymasterAndData layout: 20 (addr) + 16 (vGas) + 16 (pGas) + 6 (vU) + 6 (vA) + 65 (sig) = 129 bytes => 258 hex chars.
    expect(blob.length).toBe(2 + 2 * 129);
    // Starts with the paymaster address.
    expect(blob.slice(0, 42).toLowerCase()).toBe(PAYMASTER.toLowerCase());

    // Confirm the on-chain call was `getHash(op, validUntil, validAfter)`.
    const call = publicClient.readContract.mock.calls[0][0];
    expect(call.functionName).toBe('getHash');
    expect(call.args[1]).toBe(validUntil);
    expect(call.args[2]).toBe(validAfter);
  });

  it('defaults validUntil to ~now+1h and validAfter to 0', async () => {
    const publicClient: any = {
      readContract: vi.fn().mockResolvedValue(SPONSOR_HASH),
    };
    const op = makeOp();
    const before = Math.floor(Date.now() / 1000);
    await sponsorUserOp({
      userOp: op,
      paymaster: PAYMASTER,
      publicClient,
      verifyingSigner: signer,
    });
    const after = Math.floor(Date.now() / 1000);
    const call = publicClient.readContract.mock.calls[0][0];
    const validUntil = call.args[1] as number;
    const validAfter = call.args[2] as number;
    expect(validAfter).toBe(0);
    expect(validUntil).toBeGreaterThanOrEqual(before + 3600);
    expect(validUntil).toBeLessThanOrEqual(after + 3600);
  });

  it('the placeholder sig is replaced by the real one after signing', async () => {
    const publicClient: any = {
      readContract: vi.fn().mockResolvedValue(SPONSOR_HASH),
    };
    const op = makeOp();
    const blob = await sponsorUserOp({
      userOp: op,
      paymaster: PAYMASTER,
      publicClient,
      verifyingSigner: signer,
    });
    // The last 65 bytes should be the real signature, not zeros.
    const sigHex = blob.slice(-2 * 65);
    expect(sigHex).not.toBe('00'.repeat(65));
  });
});

describe('NO_PAYMASTER', () => {
  it('is the empty hex sentinel', () => {
    expect(NO_PAYMASTER).toBe('0x');
  });
});
