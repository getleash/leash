import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentConfigError, loadAgentRuntime } from '../src/agent-config.js';

function writeJson(path: string, obj: unknown) {
  writeFileSync(
    path,
    JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
  );
}

describe('loadAgentRuntime', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'leash-runtime-'));
    const leashDir = resolve(dir, '.leash');
    mkdirSync(resolve(leashDir, 'agent', 'cryptonit'), { recursive: true });
    writeJson(resolve(leashDir, 'config.json'), {
      owner: '0x0000000000000000000000000000000000000001',
      hub: '0x0000000000000000000000000000000000000002',
      chain: 'base',
    });
    writeJson(resolve(leashDir, 'agent', 'cryptonit', 'agent.json'), {
      name: 'cryptonit',
      subAccount: '0x0000000000000000000000000000000000000003',
      sessionKey: '0x0000000000000000000000000000000000000004',
      policyPath: resolve(dir, 'cryptonit-policy.md'),
    });
    writeJson(resolve(leashDir, 'agent', 'cryptonit', 'grant.json'), {
      grant: {
        id: '0199c0de-0000-7000-8000-000000000001',
        principal: '0x0000000000000000000000000000000000000001',
        agent: '0x0000000000000000000000000000000000000004',
        subAccount: '0x0000000000000000000000000000000000000003',
        chain: 'base',
        validFrom: 1_700_000_000,
        validUntil: 1_702_592_000,
        purpose: 'test',
        limits: {
          maxPerTransaction: '100000',
          daily: '1000000',
          weekly: '5000000',
          monthly: '15000000',
        },
        upstreams: [
          {
            name: 'coinmarketcap',
            url: 'https://mcp.coinmarketcap.com/x402/mcp',
            namespace: 'coinmarketcap',
          },
        ],
        counterparties: [],
        policyHash: '0x' + 'ab'.repeat(32),
      },
      signature: '0x' + 'cd'.repeat(65),
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads hub + agent + grant from .leash/', () => {
    const r = loadAgentRuntime({ agentName: 'cryptonit', cwd: dir });
    expect(r.agentName).toBe('cryptonit');
    expect(r.hub.chain).toBe('base');
    expect(r.agent.subAccount).toBe('0x0000000000000000000000000000000000000003');
    expect(r.signedGrant.grant.agent).toBe(
      '0x0000000000000000000000000000000000000004',
    );
    expect(r.chainConfig.chainId).toBe(8453);
    // bigint revival on limits.
    expect(r.signedGrant.grant.limits.daily).toBe(1_000_000n);
    expect(typeof r.signedGrant.grant.limits.daily).toBe('bigint');
  });

  it('throws when .leash/ does not exist', () => {
    expect(() =>
      loadAgentRuntime({ agentName: 'cryptonit', cwd: tmpdir() }),
    ).toThrow(/no \.leash\/ directory/);
  });

  it('throws when the agent directory is missing', () => {
    expect(() =>
      loadAgentRuntime({ agentName: 'other', cwd: dir }),
    ).toThrow(/no agent 'other'/);
  });

  it('throws when the grant sub-account disagrees with agent.json', () => {
    writeJson(resolve(dir, '.leash', 'agent', 'cryptonit', 'agent.json'), {
      name: 'cryptonit',
      subAccount: '0x0000000000000000000000000000000000000099',
      sessionKey: '0x0000000000000000000000000000000000000004',
      policyPath: resolve(dir, 'cryptonit-policy.md'),
    });
    expect(() =>
      loadAgentRuntime({ agentName: 'cryptonit', cwd: dir }),
    ).toThrow(/does not match agent.json subAccount/);
  });

  it('throws AgentConfigError on malformed JSON', () => {
    writeFileSync(
      resolve(dir, '.leash', 'agent', 'cryptonit', 'grant.json'),
      '{not json',
    );
    expect(() =>
      loadAgentRuntime({ agentName: 'cryptonit', cwd: dir }),
    ).toThrow(AgentConfigError);
  });
});
