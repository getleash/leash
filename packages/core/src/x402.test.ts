import { describe, expect, it } from 'vitest';
import {
  X402ParseError,
  buildPaymentPayload,
  encodeRetryHeader,
  networkToChainId,
  parseX402Challenge,
} from './x402.js';
import type {
  X402Accepted,
  X402Authorization,
  X402PaymentPayloadV1,
  X402PaymentPayloadV2,
} from './types.js';

// Canonical CMC v2 challenge shape — verbatim from
// poc/b-x402-proxy/findings.md §"402 challenge shape (exact)".
const CMC_CHALLENGE_V2 = {
  x402Version: 2,
  error: 'Payment required',
  resource: { url: 'X402_search_cryptos', description: 'search_cryptos' },
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '10000',
      payTo: '0x271189c860DB25bC43173B0335784aD68a680908',
      maxTimeoutSeconds: 30,
      extra: { name: 'USD Coin', version: '2' },
    },
  ],
};

// Synthetic v1 challenge for the body-delivery path.
const V1_BODY_CHALLENGE = {
  x402Version: 1,
  error: 'Payment required',
  accepts: [
    {
      scheme: 'exact',
      network: 'base',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      maxAmountRequired: '10000',
      payTo: '0x271189c860DB25bC43173B0335784aD68a680908',
      maxTimeoutSeconds: 30,
    },
  ],
};

function b64url(s: string): string {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

describe('parseX402Challenge (v2 header delivery)', () => {
  it('parses the canonical CMC v2 challenge from the Payment-Required header', () => {
    const c = parseX402Challenge({
      headers: { 'Payment-Required': b64url(JSON.stringify(CMC_CHALLENGE_V2)) },
      body: '',
    });
    expect(c.x402Version).toBe(2);
    expect(c.source).toBe('header');
    expect(c.retryHeader).toBe('Payment-Signature');
    expect(c.resource).toEqual(CMC_CHALLENGE_V2.resource);
    expect(c.accepts).toHaveLength(1);
    expect(c.accepts[0].network).toBe('eip155:8453');
    expect(c.accepts[0].amount).toBe('10000');
    expect(c.accepts[0].extra).toEqual({ name: 'USD Coin', version: '2' });
  });

  it('finds the header regardless of name casing', () => {
    const c = parseX402Challenge({
      headers: { 'payment-required': b64url(JSON.stringify(CMC_CHALLENGE_V2)) },
      body: '',
    });
    expect(c.x402Version).toBe(2);
  });

  it('accepts a standard-base64 (padded, + / chars) header too', () => {
    const padded = Buffer.from(JSON.stringify(CMC_CHALLENGE_V2)).toString(
      'base64',
    );
    const c = parseX402Challenge({
      headers: { 'Payment-Required': padded },
      body: '',
    });
    expect(c.x402Version).toBe(2);
  });
});

describe('parseX402Challenge (v1 body delivery)', () => {
  it('parses a v1 body challenge and flags X-PAYMENT as the retry header', () => {
    const c = parseX402Challenge({
      headers: {},
      body: JSON.stringify(V1_BODY_CHALLENGE),
    });
    expect(c.x402Version).toBe(1);
    expect(c.source).toBe('body');
    expect(c.retryHeader).toBe('X-PAYMENT');
    expect(c.accepts[0].amount).toBe('10000');
    expect(c.accepts[0].network).toBe('base');
  });
});

describe('parseX402Challenge (failure modes)', () => {
  it('throws when both header and body are empty', () => {
    expect(() => parseX402Challenge({ headers: {}, body: '' })).toThrow(
      X402ParseError,
    );
  });

  it('throws on non-JSON body', () => {
    expect(() =>
      parseX402Challenge({ headers: {}, body: 'not json' }),
    ).toThrow(/not valid JSON/);
  });

  it('throws on unsupported version', () => {
    expect(() =>
      parseX402Challenge({
        headers: {},
        body: JSON.stringify({ ...V1_BODY_CHALLENGE, x402Version: 99 }),
      }),
    ).toThrow(/unsupported x402Version/);
  });

  it('throws when no accepts[] entry uses a scheme Leash supports', () => {
    const bad = {
      ...CMC_CHALLENGE_V2,
      // Only `exact` is supported today; a future scheme like
      // `subscription` or `upTo` would be silently filtered.
      accepts: [{ ...CMC_CHALLENGE_V2.accepts[0], scheme: 'upTo' }],
    };
    expect(() =>
      parseX402Challenge({
        headers: { 'Payment-Required': b64url(JSON.stringify(bad)) },
        body: '',
      }),
    ).toThrow(/no usable accepts\[\] entry/);
  });

  it('throws when no accepts[] entry uses a chain/scheme Leash supports', () => {
    const bad = {
      ...CMC_CHALLENGE_V2,
      // Only an ETH-mainnet entry — Leash is Base-only today.
      accepts: [{ ...CMC_CHALLENGE_V2.accepts[0], network: 'eip155:1' }],
    };
    expect(() =>
      parseX402Challenge({
        headers: { 'Payment-Required': b64url(JSON.stringify(bad)) },
        body: '',
      }),
    ).toThrow(/no usable accepts\[\] entry/);
  });

  it('filters a multi-chain accepts[] to keep only Base-compatible entries', () => {
    // Verbatim shape from the invy / azursafe live 402 (2026-05-16):
    // they publish [Base, ETH mainnet, Solana] (and friends). Leash
    // picks the Base entry; the others stay valid for other clients
    // and Leash should silently drop them, not fail the whole parse.
    const multi = {
      ...CMC_CHALLENGE_V2,
      accepts: [
        {
          ...CMC_CHALLENGE_V2.accepts[0],
          network: 'eip155:8453',
          payTo: '0x19c5fbc520a3a8c2fa440148193de4543a5fc66a',
        },
        {
          // ETH mainnet — Leash doesn't support, must be dropped.
          ...CMC_CHALLENGE_V2.accepts[0],
          network: 'eip155:1',
          asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          payTo: '0x19c5fbc520a3a8c2fa440148193de4543a5fc66a',
        },
        {
          // Solana — unsupported scheme/network shape, must be dropped.
          ...CMC_CHALLENGE_V2.accepts[0],
          network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
          asset: '0xEPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          payTo: '0x19c5fbc520a3a8c2fa440148193de4543a5fc66a',
        },
      ],
    };
    const parsed = parseX402Challenge({
      headers: { 'Payment-Required': b64url(JSON.stringify(multi)) },
      body: '',
    });
    expect(parsed.accepts).toHaveLength(1);
    expect(parsed.accepts[0].network).toBe('eip155:8453');
    expect(parsed.accepts[0].payTo).toBe(
      '0x19c5fbc520a3a8c2fa440148193de4543a5fc66a',
    );
  });

  it('throws on malformed payTo', () => {
    const bad = {
      ...CMC_CHALLENGE_V2,
      accepts: [{ ...CMC_CHALLENGE_V2.accepts[0], payTo: '0xnope' }],
    };
    expect(() =>
      parseX402Challenge({
        headers: { 'Payment-Required': b64url(JSON.stringify(bad)) },
        body: '',
      }),
    ).toThrow(/payTo must be a 20-byte/);
  });
});

describe('networkToChainId', () => {
  it('maps CAIP-2 and shorthand to the same chain id', () => {
    expect(networkToChainId('base')).toBe(8453);
    expect(networkToChainId('eip155:8453')).toBe(8453);
    expect(networkToChainId('base-sepolia')).toBe(84532);
    expect(networkToChainId('eip155:84532')).toBe(84532);
  });
});

describe('buildPaymentPayload', () => {
  const CHOSEN: X402Accepted = {
    scheme: 'exact',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount: '10000',
    payTo: '0x271189c860DB25bC43173B0335784aD68a680908',
    maxTimeoutSeconds: 30,
    extra: { name: 'USD Coin', version: '2' },
  };
  const AUTH: X402Authorization = {
    from: '0x6bD660201f64De3064D94Be02D3EaFb5978F2022',
    to: '0x271189c860DB25bC43173B0335784aD68a680908',
    value: '10000',
    validAfter: '1700000000',
    validBefore: '1700001000',
    nonce:
      '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  };
  const SIG = ('0x' + 'ab'.repeat(66)) as `0x${string}`;

  it('builds a v2 payload nesting scheme/network inside `accepted`', () => {
    const challenge = parseX402Challenge({
      headers: { 'Payment-Required': b64url(JSON.stringify(CMC_CHALLENGE_V2)) },
      body: '',
    });
    const p = buildPaymentPayload({
      challenge,
      chosen: challenge.accepts[0],
      signature: SIG,
      authorization: AUTH,
    }) as X402PaymentPayloadV2;

    expect(p.x402Version).toBe(2);
    expect(p.resource).toEqual(CMC_CHALLENGE_V2.resource);
    expect(p.accepted).toBe(challenge.accepts[0]);
    expect(p.payload.signature).toBe(SIG);
    expect(p.payload.authorization).toEqual(AUTH);
    // Regression guard: v2 does NOT hoist scheme/network.
    expect((p as unknown as Record<string, unknown>).scheme).toBeUndefined();
    expect((p as unknown as Record<string, unknown>).network).toBeUndefined();
  });

  it('builds a v1 payload hoisting scheme/network at the top', () => {
    const challenge = parseX402Challenge({
      headers: {},
      body: JSON.stringify(V1_BODY_CHALLENGE),
    });
    const p = buildPaymentPayload({
      challenge,
      chosen: challenge.accepts[0],
      signature: SIG,
      authorization: AUTH,
    }) as X402PaymentPayloadV1;

    expect(p.x402Version).toBe(1);
    expect(p.scheme).toBe('exact');
    expect(p.network).toBe('base');
    expect(p.payload.signature).toBe(SIG);
  });

  it('attaches optional leashMeta under payload.meta.leash', () => {
    const challenge = parseX402Challenge({
      headers: { 'Payment-Required': b64url(JSON.stringify(CMC_CHALLENGE_V2)) },
      body: '',
    });
    const p = buildPaymentPayload({
      challenge,
      chosen: challenge.accepts[0],
      signature: SIG,
      authorization: AUTH,
      leashMeta: { grantId: '0199-test', grantRef: { url: 'https://leash.example/grants/0199-test' } },
    }) as X402PaymentPayloadV2;
    expect(p.meta?.leash?.grantId).toBe('0199-test');
    expect(p.meta?.leash?.grantRef).toEqual({ url: 'https://leash.example/grants/0199-test' });
  });

  it('omits the meta field entirely when leashMeta is not provided', () => {
    const challenge = parseX402Challenge({
      headers: { 'Payment-Required': b64url(JSON.stringify(CMC_CHALLENGE_V2)) },
      body: '',
    });
    const p = buildPaymentPayload({
      challenge,
      chosen: challenge.accepts[0],
      signature: SIG,
      authorization: AUTH,
    }) as X402PaymentPayloadV2;
    expect((p as unknown as Record<string, unknown>).meta).toBeUndefined();
  });

  it('rejects a chosen entry not found in the challenge', () => {
    const challenge = parseX402Challenge({
      headers: { 'Payment-Required': b64url(JSON.stringify(CMC_CHALLENGE_V2)) },
      body: '',
    });
    expect(() =>
      buildPaymentPayload({
        challenge,
        chosen: { ...CHOSEN, amount: '99999' },
        signature: SIG,
        authorization: AUTH,
      }),
    ).toThrow(/chosen accepted terms not found/);
  });
});

describe('encodeRetryHeader', () => {
  const AUTH: X402Authorization = {
    from: '0x6bD660201f64De3064D94Be02D3EaFb5978F2022',
    to: '0x271189c860DB25bC43173B0335784aD68a680908',
    value: '10000',
    validAfter: '1700000000',
    validBefore: '1700001000',
    nonce: '0x' + '11'.repeat(32),
  };
  const SIG = ('0x' + 'ab'.repeat(66)) as `0x${string}`;

  it('uses Payment-Signature for v2 and X-PAYMENT for v1', () => {
    const v2 = parseX402Challenge({
      headers: { 'Payment-Required': b64url(JSON.stringify(CMC_CHALLENGE_V2)) },
      body: '',
    });
    const h2 = encodeRetryHeader(
      buildPaymentPayload({
        challenge: v2,
        chosen: v2.accepts[0],
        signature: SIG,
        authorization: AUTH,
      }),
    );
    expect(h2.name).toBe('Payment-Signature');
    expect(h2.value).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding

    const v1 = parseX402Challenge({
      headers: {},
      body: JSON.stringify(V1_BODY_CHALLENGE),
    });
    const h1 = encodeRetryHeader(
      buildPaymentPayload({
        challenge: v1,
        chosen: v1.accepts[0],
        signature: SIG,
        authorization: AUTH,
      }),
    );
    expect(h1.name).toBe('X-PAYMENT');
  });

  it('round-trips: decode the header back to the same payload JSON', () => {
    const c = parseX402Challenge({
      headers: { 'Payment-Required': b64url(JSON.stringify(CMC_CHALLENGE_V2)) },
      body: '',
    });
    const payload = buildPaymentPayload({
      challenge: c,
      chosen: c.accepts[0],
      signature: SIG,
      authorization: AUTH,
    });
    const { value } = encodeRetryHeader(payload);
    const padded =
      value.length % 4 === 0
        ? value
        : value + '='.repeat(4 - (value.length % 4));
    const decoded = Buffer.from(
      padded.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8');
    expect(JSON.parse(decoded)).toEqual(payload);
  });
});
