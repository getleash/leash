import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import {
  canonicalizeGrant,
  hashAuthorizationGrant,
  hashPolicyMarkdown,
  mintGrantId,
  signAuthorizationGrant,
  verifyAuthorizationGrantSignature,
} from './authorization.js';
import type { AuthorizationGrant } from './types.js';

const PRINCIPAL_PK: Hex =
  '0x1111111111111111111111111111111111111111111111111111111111111111';
const OTHER_PK: Hex =
  '0x2222222222222222222222222222222222222222222222222222222222222222';

const principalAccount = privateKeyToAccount(PRINCIPAL_PK);
const otherAccount = privateKeyToAccount(OTHER_PK);

function sampleGrant(overrides: Partial<AuthorizationGrant> = {}): AuthorizationGrant {
  return {
    id: '0199c0de-0000-7000-8000-000000000001',
    principal: principalAccount.address,
    agent: '0x6C718844Aaa21cAad240C2F968173095f62b40D9',
    subAccount: '0x6bD660201f64De3064D94Be02D3EaFb5978F2022',
    chain: 'base',
    validFrom: 1_700_000_000,
    validUntil: 1_702_592_000,
    purpose: 'Pay CoinMarketCap Pro per-call for market data.',
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
    counterparties: [],
    policyHash: hashPolicyMarkdown('# Agent Policy\nname: cryptonit\n'),
    ...overrides,
  };
}

describe('hashAuthorizationGrant', () => {
  it('returns a 32-byte EIP-712 digest', () => {
    const h = hashAuthorizationGrant(sampleGrant());
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(hashAuthorizationGrant(sampleGrant())).toBe(
      hashAuthorizationGrant(sampleGrant()),
    );
  });

  it('changes when any scope field changes', () => {
    const base = sampleGrant();
    const h0 = hashAuthorizationGrant(base);
    expect(hashAuthorizationGrant({ ...base, purpose: 'something else' })).not.toBe(h0);
    expect(
      hashAuthorizationGrant({
        ...base,
        limits: { ...base.limits, daily: 999_999n },
      }),
    ).not.toBe(h0);
    expect(hashAuthorizationGrant({ ...base, validUntil: base.validUntil + 1 })).not.toBe(h0);
  });

  it('canonicalizes array order (upstreams)', () => {
    const a = sampleGrant({
      upstreams: [
        { name: 'b-upstream', url: 'https://b/', namespace: 'b' },
        { name: 'a-upstream', url: 'https://a/', namespace: 'a' },
      ],
    });
    const b = sampleGrant({
      upstreams: [
        { name: 'a-upstream', url: 'https://a/', namespace: 'a' },
        { name: 'b-upstream', url: 'https://b/', namespace: 'b' },
      ],
    });
    expect(hashAuthorizationGrant(a)).toBe(hashAuthorizationGrant(b));
  });

  it('canonicalizes array order (counterparties)', () => {
    const TWO = {
      name: 'two',
      address: '0x0000000000000000000000000000000000000002',
    } as const;
    const ONE = {
      name: 'one',
      address: '0x0000000000000000000000000000000000000001',
    } as const;
    const a = sampleGrant({ counterparties: [TWO, ONE] });
    const b = sampleGrant({ counterparties: [ONE, TWO] });
    expect(hashAuthorizationGrant(a)).toBe(hashAuthorizationGrant(b));
  });

  it('differs between chains (domain is chain-bound)', () => {
    const mainnet = hashAuthorizationGrant(sampleGrant({ chain: 'base' }));
    const sepolia = hashAuthorizationGrant(sampleGrant({ chain: 'base-sepolia' }));
    expect(mainnet).not.toBe(sepolia);
  });
});

describe('sign + verify round-trip', () => {
  it('verifies against the signing principal', async () => {
    const signed = await signAuthorizationGrant(sampleGrant(), principalAccount);
    const res = await verifyAuthorizationGrantSignature(signed);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.signer).toBe(principalAccount.address);
  });

  it('refuses to sign when the account does not match grant.principal', async () => {
    await expect(
      signAuthorizationGrant(sampleGrant(), otherAccount),
    ).rejects.toThrow(/does not match grant.principal/);
  });

  it('verify fails when the signature is tampered with', async () => {
    const signed = await signAuthorizationGrant(sampleGrant(), principalAccount);
    // Flip a byte in the `r` component (byte 4, i.e. hex chars 10-11 after 0x).
    // Changing only v can round-trip to a different-but-valid signer under
    // some libs; mutating r reliably breaks recovery.
    const sig = signed.signature;
    const tamperedHex =
      sig.slice(0, 10) +
      (sig[10] === 'f' ? '0' : 'f') +
      sig.slice(11);
    const tampered = { ...signed, signature: tamperedHex as Hex };
    const res = await verifyAuthorizationGrantSignature(tampered);
    expect(res.ok).toBe(false);
  });

  it('verify fails when the grant scope is tampered with', async () => {
    const signed = await signAuthorizationGrant(sampleGrant(), principalAccount);
    const tampered = {
      ...signed,
      grant: {
        ...signed.grant,
        limits: { ...signed.grant.limits, daily: signed.grant.limits.daily + 1n },
      },
    };
    const res = await verifyAuthorizationGrantSignature(tampered);
    expect(res.ok).toBe(false);
  });

  it('verify fails when the claimed principal is swapped', async () => {
    const signed = await signAuthorizationGrant(sampleGrant(), principalAccount);
    const tampered = {
      ...signed,
      grant: { ...signed.grant, principal: otherAccount.address },
    };
    const res = await verifyAuthorizationGrantSignature(tampered);
    expect(res.ok).toBe(false);
  });

  it('produces the same signature given canonically-equivalent input', async () => {
    const a = sampleGrant({
      upstreams: [
        { name: 'b-upstream', url: 'https://b/', namespace: 'b' },
        { name: 'a-upstream', url: 'https://a/', namespace: 'a' },
      ],
    });
    const b = sampleGrant({
      upstreams: [
        { name: 'a-upstream', url: 'https://a/', namespace: 'a' },
        { name: 'b-upstream', url: 'https://b/', namespace: 'b' },
      ],
    });
    const sigA = await signAuthorizationGrant(a, principalAccount);
    const sigB = await signAuthorizationGrant(b, principalAccount);
    expect(sigA.signature).toBe(sigB.signature);
  });
});

describe('canonicalizeGrant', () => {
  it('returns upstreams sorted by name', () => {
    const c = canonicalizeGrant(
      sampleGrant({
        upstreams: [
          { name: 'z', url: 'https://z/', namespace: 'z' },
          { name: 'a', url: 'https://a/', namespace: 'a' },
          { name: 'm', url: 'https://m/', namespace: 'm' },
        ],
      }),
    );
    expect(c.upstreams.map((u) => u.name)).toEqual(['a', 'm', 'z']);
  });

  it('leaves other fields untouched', () => {
    const g = sampleGrant();
    const c = canonicalizeGrant(g);
    expect(c.id).toBe(g.id);
    expect(c.purpose).toBe(g.purpose);
    expect(c.policyHash).toBe(g.policyHash);
  });
});

describe('hashPolicyMarkdown', () => {
  it('is a 32-byte keccak256 of UTF-8 bytes', () => {
    const h = hashPolicyMarkdown('hello');
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(hashPolicyMarkdown('x')).toBe(hashPolicyMarkdown('x'));
  });

  it('differs by a single byte of input', () => {
    expect(hashPolicyMarkdown('x')).not.toBe(hashPolicyMarkdown('y'));
  });
});

describe('mintGrantId', () => {
  it('returns a valid UUID v7 (version 7 in the third group)', () => {
    const id = mintGrantId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('generates unique IDs on rapid calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(mintGrantId());
    expect(ids.size).toBe(50);
  });

  it('is time-sortable (sequential IDs sort chronologically)', async () => {
    const a = mintGrantId();
    // Wait long enough that timestamp diff is guaranteed.
    await new Promise((r) => setTimeout(r, 5));
    const b = mintGrantId();
    expect(a < b).toBe(true);
  });
});
