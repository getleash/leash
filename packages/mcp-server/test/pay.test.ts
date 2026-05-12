import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import {
  BASE_MAINNET,
  hashTransferWithAuthorization,
  wrapForKernel,
  type X402Accepted,
  type X402Challenge,
} from '@getleash/core';
import { signX402Payment } from '../src/proxy/pay.js';
import { coinmarketcapAdapter } from '../src/upstreams/coinmarketcap.js';
import type { AgentRuntime } from '../src/agent-config.js';

const SESSION_PK: Hex =
  '0x1111111111111111111111111111111111111111111111111111111111111111';
const sessionKey = privateKeyToAccount(SESSION_PK);

function runtime(): AgentRuntime {
  return {
    agentName: 'cryptonit',
    hub: {
      owner: '0x0000000000000000000000000000000000000001',
      hub: '0x0000000000000000000000000000000000000002',
      chain: 'base',
    },
    agent: {
      name: 'cryptonit',
      subAccount: '0x6bD660201f64De3064D94Be02D3EaFb5978F2022',
      sessionKey: sessionKey.address,
      policyPath: '/tmp/policy.md',
    },
    signedGrant: {
      grant: {
        id: 'g-1',
        principal: '0x0000000000000000000000000000000000000001',
        agent: sessionKey.address,
        subAccount: '0x6bD660201f64De3064D94Be02D3EaFb5978F2022',
        chain: 'base',
        validFrom: 0,
        validUntil: 2_000_000_000,
        purpose: 't',
        limits: {
          maxPerTransaction: 100_000n,
          daily: 1_000_000n,
          weekly: 5_000_000n,
          monthly: 15_000_000n,
        },
        upstreams: [],
        counterparties: [],
        policyHash: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
      },
      signature: ('0x' + 'cd'.repeat(65)) as `0x${string}`,
    },
    chainConfig: BASE_MAINNET,
    leashRoot: '/tmp/.leash',
  };
}

const CHOSEN: X402Accepted = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: BASE_MAINNET.usdc,
  amount: '10000',
  payTo: '0x271189c860DB25bC43173B0335784aD68a680908',
  maxTimeoutSeconds: 30,
  extra: { name: 'USD Coin', version: '2' },
};

const CHALLENGE: X402Challenge = {
  x402Version: 2,
  error: 'Payment required',
  resource: { url: 'cmc/search', description: 'search' },
  accepts: [CHOSEN],
  source: 'header',
  retryHeader: 'Payment-Signature',
};

describe('signX402Payment', () => {
  it('produces a signature, 0x-prefixed authorization, and matching digests', async () => {
    const signed = await signX402Payment({
      challenge: CHALLENGE,
      chosen: CHOSEN,
      adapter: coinmarketcapAdapter,
      runtime: runtime(),
      sessionKey,
      nowSec: 1_700_000_000,
    });

    // Witness-bearing signature layout:
    //   0x01 || sessionKeyValidator(20) || ECDSA(65) || witness(160) = 246 bytes.
    const validator = BASE_MAINNET.sessionKeyValidator.toLowerCase().slice(2);
    expect(signed.signature.length).toBe(2 + 246 * 2);
    expect(signed.signature.toLowerCase().startsWith('0x01' + validator)).toBe(true);
    expect(signed.authorization.from).toBe(runtime().agent.subAccount);
    expect(signed.authorization.to).toBe(CHOSEN.payTo);
    expect(signed.authorization.value).toBe('10000');

    // validAfter/validBefore bracket the timestamp correctly.
    expect(Number(signed.authorization.validAfter)).toBe(1_700_000_000 - 60);
    expect(Number(signed.authorization.validBefore)).toBe(
      1_700_000_000 + CHOSEN.maxTimeoutSeconds + 60,
    );

    // Reproduce authorization_digest independently.
    const reproDigest = hashTransferWithAuthorization({
      from: runtime().agent.subAccount,
      to: CHOSEN.payTo,
      value: 10_000n,
      validAfter: BigInt(1_700_000_000 - 60),
      validBefore: BigInt(1_700_000_000 + 30 + 60),
      nonce: signed.authorization.nonce,
      usdc: CHOSEN.asset,
      usdcDomainName: 'USD Coin',
      usdcDomainVersion: '2',
      chainId: 8453,
    });
    expect(signed.authorizationDigest).toBe(reproDigest);

    // Reproduce kernelDigest.
    const reproKernel = wrapForKernel({
      innerHash: signed.authorizationDigest,
      subAccount: runtime().agent.subAccount,
      chainId: 8453,
    });
    expect(signed.kernelDigest).toBe(reproKernel);
  });

  it('falls back to ChainConfig USDC domain when the challenge extra is absent (hardcoded source)', async () => {
    const adapter = { ...coinmarketcapAdapter, usdcDomainSource: 'hardcoded' as const };
    // Challenge without extra.name/version.
    const chosenNoExtra = { ...CHOSEN, extra: {} as { name?: string; version?: string } };
    const signed = await signX402Payment({
      challenge: { ...CHALLENGE, accepts: [chosenNoExtra] },
      chosen: chosenNoExtra,
      adapter,
      runtime: runtime(),
      sessionKey,
      nowSec: 1_700_000_000,
    });
    // Digest must use ChainConfig values now ("USD Coin", "2").
    const reproDigest = hashTransferWithAuthorization({
      from: runtime().agent.subAccount,
      to: chosenNoExtra.payTo,
      value: 10_000n,
      validAfter: BigInt(1_700_000_000 - 60),
      validBefore: BigInt(1_700_000_000 + 30 + 60),
      nonce: signed.authorization.nonce,
      usdc: chosenNoExtra.asset,
      usdcDomainName: BASE_MAINNET.usdcDomainName,
      usdcDomainVersion: BASE_MAINNET.usdcDomainVersion,
      chainId: 8453,
    });
    expect(signed.authorizationDigest).toBe(reproDigest);
  });
});
