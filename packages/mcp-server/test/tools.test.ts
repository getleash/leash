import { describe, expect, it, vi } from 'vitest';
import { BASE_MAINNET } from '@getleash/core';
import type { AgentRuntime } from '../src/agent-config.js';
import type { ToolContext } from '../src/tools/types.js';
import { handleGetBalance } from '../src/tools/get_balance.js';
import { handleGetApiBudget } from '../src/tools/get_api_budget.js';
import { handleTransfer } from '../src/tools/transfer.js';
import { handlePayForApi } from '../src/tools/pay_for_api.js';
import { PaymentLog } from '../src/db.js';
import type { SessionKeyStore } from '../src/session-key.js';

function fakeRuntime(): AgentRuntime {
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
      sessionKey: '0x6C718844Aaa21cAad240C2F968173095f62b40D9',
      policyPath: '/tmp/cryptonit-policy.md',
    },
    signedGrant: {
      grant: {
        id: '0199c0de-0000-7000-8000-000000000001',
        principal: '0x0000000000000000000000000000000000000001',
        agent: '0x6C718844Aaa21cAad240C2F968173095f62b40D9',
        subAccount: '0x6bD660201f64De3064D94Be02D3EaFb5978F2022',
        chain: 'base',
        validFrom: 1_700_000_000,
        validUntil: 2_000_000_000,
        purpose: 'test',
        limits: {
          maxPerTransaction: 100_000n,
          daily: 1_000_000n,
          weekly: 5_000_000n,
          monthly: 15_000_000n,
        },
        upstreams: [
          {
            name: 'coinmarketcap',
            url: 'https://mcp.coinmarketcap.com/x402/mcp',
            namespace: 'coinmarketcap',
          },
        ],
        counterparties: [
          {
            name: 'monthly-invoice',
            address: '0x000000000000000000000000000000000000aaaa',
          },
        ],
        policyHash: ('0x' + 'ab'.repeat(32)) as `0x${string}`,
      },
      signature: ('0x' + 'cd'.repeat(65)) as `0x${string}`,
    },
    chainConfig: BASE_MAINNET,
    leashRoot: '/tmp/.leash',
  };
}

function noopSessionKeys(): SessionKeyStore {
  return {
    loadAgentKey: () => {
      throw new Error('session key store not wired in this test');
    },
    loadHubOwnerKey: () => {
      throw new Error('hub owner store not wired in this test');
    },
  };
}

describe('get_balance', () => {
  it('reads USDC.balanceOf(subAccount) by default', async () => {
    const publicClient: any = {
      readContract: vi.fn().mockResolvedValue(1_234_567n),
    };
    const db = new PaymentLog(':memory:');
    const out = await handleGetBalance(
      {
        runtime: fakeRuntime(),
        publicClient,
        db,
        sessionKeys: noopSessionKeys(),
        upstreams: [],
      },
      {},
    );
    expect(out.balance_usdc).toBe('1.234567');
    const call = publicClient.readContract.mock.calls[0][0];
    expect(call.address).toBe(BASE_MAINNET.usdc);
    expect(call.args).toEqual([fakeRuntime().agent.subAccount]);
  });
});

describe('get_api_budget (live accounting)', () => {
  it("reports 'live' and reflects spend from the DB", async () => {
    const db = new PaymentLog(':memory:');
    // 0.45 USDC spent today.
    db.insertPayment({
      grantId: fakeRuntime().signedGrant.grant.id,
      kind: 'userop',
      amount: 450_000n,
      recipient: '0x000000000000000000000000000000000000aaaa',
      status: 'confirmed',
      createdAtMs: Date.now() - 60_000,
    });
    const out = await handleGetApiBudget({
      runtime: fakeRuntime(),
      publicClient: {} as any,
      db,
      sessionKeys: noopSessionKeys(),
        upstreams: [],
    });
    expect(out.accounting).toBe('live');
    expect(out.spent.today_usdc).toBe('0.45');
    expect(out.remaining.today_usdc).toBe('0.55'); // 1.00 − 0.45
  });
});

describe('transfer — denial paths (no bundler needed)', () => {
  it('rejects amount exceeding the per-tx cap', async () => {
    const db = new PaymentLog(':memory:');
    const res = await handleTransfer(
      {
        runtime: fakeRuntime(),
        publicClient: {} as any,
        db,
        sessionKeys: noopSessionKeys(),
        upstreams: [],
      },
      {
        to: '0x000000000000000000000000000000000000aaaa',
        amount_usdc: '1.00', // cap is 0.10
      },
    );
    expect('isError' in res && res.isError).toBe(true);
    if ('isError' in res) {
      expect(res.structuredContent.code).toBe('OVER_PER_TX_CAP');
    }
  });

  it('rejects a recipient not on the counterparty allowlist', async () => {
    const db = new PaymentLog(':memory:');
    const res = await handleTransfer(
      {
        runtime: fakeRuntime(),
        publicClient: {} as any,
        db,
        sessionKeys: noopSessionKeys(),
        upstreams: [],
      },
      {
        to: '0x0000000000000000000000000000000000000999',
        amount_usdc: '0.05',
      },
    );
    expect('isError' in res && res.isError).toBe(true);
    if ('isError' in res) {
      expect(res.structuredContent.code).toBe('RECIPIENT_NOT_ALLOWLISTED');
    }
  });

  it('rejects an unparseable amount', async () => {
    const db = new PaymentLog(':memory:');
    const res = await handleTransfer(
      {
        runtime: fakeRuntime(),
        publicClient: {} as any,
        db,
        sessionKeys: noopSessionKeys(),
        upstreams: [],
      },
      { to: '0x000000000000000000000000000000000000aaaa', amount_usdc: 'abc' },
    );
    expect('isError' in res && res.isError).toBe(true);
  });

  it('rejects when bundlerWallet is missing in the context', async () => {
    const db = new PaymentLog(':memory:');
    const res = await handleTransfer(
      {
        runtime: fakeRuntime(),
        publicClient: {} as any,
        db,
        sessionKeys: noopSessionKeys(),
        upstreams: [],
        // no bundlerWallet
      },
      {
        to: '0x000000000000000000000000000000000000aaaa',
        amount_usdc: '0.05',
      },
    );
    expect('isError' in res && res.isError).toBe(true);
    if ('isError' in res) {
      expect(res.structuredContent.details).toMatchObject({
        hint: 'bundler_wallet_missing',
      });
    }
  });
});

describe('pay_for_api (explicit signing)', () => {
  it('rejects an unknown upstream', async () => {
    const db = new PaymentLog(':memory:');
    const res = await handlePayForApi(
      {
        runtime: fakeRuntime(),
        publicClient: {} as any,
        db,
        sessionKeys: noopSessionKeys(),
        upstreams: []
      },
      { upstream: 'opensea', challenge_base64: '' },
    );
    expect('isError' in res && res.isError).toBe(true);
    if ('isError' in res) {
      expect(res.structuredContent.code).toBe('CONFIG_MISSING');
      expect(res.structuredContent.details).toMatchObject({ upstream: 'opensea' });
    }
  });

  it('rejects malformed base64 challenge input', async () => {
    const db = new PaymentLog(':memory:');
    const res = await handlePayForApi(
      {
        runtime: fakeRuntime(),
        publicClient: {} as any,
        db,
        sessionKeys: noopSessionKeys(),
        upstreams: []
      },
      { upstream: 'coinmarketcap', challenge_base64: 'not-json' },
    );
    expect('isError' in res && res.isError).toBe(true);
  });
});
