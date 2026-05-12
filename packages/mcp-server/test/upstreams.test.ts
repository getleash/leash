import { describe, expect, it } from 'vitest';
import {
  getUpstreamAdapter,
  supportedUpstreamNames,
} from '../src/upstreams/registry.js';
import { coinmarketcapAdapter } from '../src/upstreams/coinmarketcap.js';

describe('upstream registry', () => {
  it('lists the 10 live-verified upstreams', () => {
    // 9 confirmed-pass in D.5 smoke 2026-05-12 + donate-0000402 confirmed
    // in D.8 smoke (re-tested after probe). 9 candidate adapters dropped
    // after live mainnet smoke; see registry.ts for the deferred list and
    // the per-upstream reason.
    expect(supportedUpstreamNames().sort()).toEqual([
      'agoragentic',
      'azursafe',
      'coinmarketcap',
      'donate-0000402',
      'exa',
      'gloria',
      'invy',
      'neynar',
      'orac',
      'ottoai',
    ]);
  });

  it('returns the CMC adapter by name', () => {
    expect(getUpstreamAdapter('coinmarketcap')).toBe(coinmarketcapAdapter);
  });

  it('returns undefined for unsupported upstreams', () => {
    expect(getUpstreamAdapter('opensea')).toBeUndefined();
  });
});

describe('coinmarketcap adapter (PoC-B pins)', () => {
  it('x402 v2, header delivery, challenge-extra domain', () => {
    // These are load-bearing — PoC-B proved them against live CMC.
    // Changing any of them without re-verifying live is a regression.
    expect(coinmarketcapAdapter).toEqual({
      name: 'coinmarketcap',
      transport: 'mcp',
      x402Version: 2,
      challengeLocation: 'header',
      usdcDomainSource: 'challenge-extra',
    });
  });
});
