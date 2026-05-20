import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePolicy, PolicyParseError } from './policy-parser.js';

// Minimal valid policy; individual tests mutate copies of this.
const VALID = `# Agent Policy
name: cryptonit
chain: base
validity: 30 days
initial_funding: 1.00 USDC

## Limits
max_per_transaction: 0.10 USDC
daily_limit:         1.00 USDC
weekly_limit:        5.00 USDC
monthly_limit:      15.00 USDC

## Upstreams
- name: coinmarketcap
  url: https://mcp.coinmarketcap.com/x402/mcp
  namespace: coinmarketcap

## Recovery
drain_to_hub: enabled
`;

describe('parsePolicy (happy path)', () => {
  it('parses the frozen cryptonit policy', () => {
    const p = parsePolicy(VALID);
    expect(p.name).toBe('cryptonit');
    expect(p.chain).toBe('base');
    expect(p.validityDays).toBe(30);
    expect(p.initialFunding).toBe(1_000_000n);
    expect(p.limits.maxPerTransaction).toBe(100_000n);
    expect(p.limits.daily).toBe(1_000_000n);
    expect(p.limits.weekly).toBe(5_000_000n);
    expect(p.limits.monthly).toBe(15_000_000n);
    expect(p.upstreams).toEqual([
      {
        name: 'coinmarketcap',
        url: 'https://mcp.coinmarketcap.com/x402/mcp',
        namespace: 'coinmarketcap',
      },
    ]);
    expect(p.drainToHub).toBe(true);
    expect(p.counterparties).toEqual([]);
  });

  it('parses the canonical example file on disk', () => {
    const path = resolve(
      __dirname,
      '..',
      '..',
      '..',
      'examples',
      'cryptonit',
      'cryptonit-policy.md',
    );
    const p = parsePolicy(readFileSync(path, 'utf8'));
    expect(p.name).toBe('cryptonit');
    expect(p.upstreams).toHaveLength(1);
    expect(p.drainToHub).toBe(true);
  });

  it('parses optional counterparties', () => {
    const p = parsePolicy(
      VALID +
        `
## Counterparties
- name: monthly-invoice
  address: 0x1234567890123456789012345678901234567890
`,
    );
    expect(p.counterparties).toEqual([
      {
        name: 'monthly-invoice',
        address: '0x1234567890123456789012345678901234567890',
      },
    ]);
  });

  it('ignores comment lines inside sections', () => {
    const p = parsePolicy(VALID.replace('## Recovery', '## Recovery\n# comment'));
    expect(p.drainToHub).toBe(true);
  });
});

describe('parsePolicy (required fields)', () => {
  it('rejects missing name', () => {
    expect(() => parsePolicy(VALID.replace('name: cryptonit\n', ''))).toThrow(
      /missing required field: name/,
    );
  });

  it('rejects missing chain', () => {
    expect(() => parsePolicy(VALID.replace('chain: base\n', ''))).toThrow(
      /missing required field: chain/,
    );
  });

  it('rejects missing validity', () => {
    expect(() => parsePolicy(VALID.replace('validity: 30 days\n', ''))).toThrow(
      /missing required field: validity/,
    );
  });

  it('rejects missing initial_funding', () => {
    expect(() =>
      parsePolicy(VALID.replace('initial_funding: 1.00 USDC\n', '')),
    ).toThrow(/missing required field: initial_funding/);
  });

  it('rejects missing ## Limits', () => {
    const bad = VALID.replace(/## Limits[\s\S]*?(?=## Upstreams)/, '');
    expect(() => parsePolicy(bad)).toThrow(/missing required limit/);
  });

  it('rejects missing ## Recovery section', () => {
    const bad = VALID.replace(/## Recovery[\s\S]*$/, '');
    expect(() => parsePolicy(bad)).toThrow(
      /missing required section "## Recovery"/,
    );
  });

  it('rejects drain_to_hub != enabled', () => {
    const bad = VALID.replace('drain_to_hub: enabled', 'drain_to_hub: disabled');
    expect(() => parsePolicy(bad)).toThrow(
      /drain_to_hub must be "enabled"/,
    );
  });

  it('rejects empty ## Upstreams', () => {
    const bad = VALID.replace(
      /## Upstreams[\s\S]*?(?=## Recovery)/,
      '## Upstreams\n\n',
    );
    expect(() => parsePolicy(bad)).toThrow(/at least one upstream required/);
  });
});

describe('parsePolicy (field validation with line numbers)', () => {
  it('rejects invalid chain with line number', () => {
    const bad = VALID.replace('chain: base', 'chain: ethereum');
    try {
      parsePolicy(bad);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PolicyParseError);
      expect((e as PolicyParseError).message).toMatch(
        /line 3: invalid chain "ethereum"/,
      );
    }
  });

  it('rejects malformed validity', () => {
    const bad = VALID.replace('validity: 30 days', 'validity: a month');
    expect(() => parsePolicy(bad)).toThrow(/line 4: invalid validity/);
  });

  it('rejects malformed USDC amount', () => {
    const bad = VALID.replace(
      'daily_limit:         1.00 USDC',
      'daily_limit: one dollar',
    );
    expect(() => parsePolicy(bad)).toThrow(/invalid USDC amount "one dollar"/);
  });

  it('rejects an unsupported upstream by name', () => {
    const bad = VALID.replace('- name: coinmarketcap', '- name: opensea');
    expect(() => parsePolicy(bad)).toThrow(
      /upstream "opensea" has no Leash adapter/,
    );
  });

  it('rejects an upstream url without https', () => {
    const bad = VALID.replace(
      'url: https://mcp.coinmarketcap.com/x402/mcp',
      'url: http://example.com',
    );
    expect(() => parsePolicy(bad)).toThrow(/upstream url must be https/);
  });

  it('rejects an invalid upstream namespace', () => {
    const bad = VALID.replace(
      'namespace: coinmarketcap',
      'namespace: Coin-Market!',
    );
    expect(() => parsePolicy(bad)).toThrow(/must match/);
  });

  it('accepts a hyphenated upstream namespace (catalog uses e.g. donate-0000402)', () => {
    const hyphenated = VALID.replace(
      'namespace: coinmarketcap',
      'namespace: donate-0000402',
    );
    const p = parsePolicy(hyphenated);
    expect(p.upstreams[0].namespace).toBe('donate-0000402');
  });

  it('parses an optional max_per_call on an upstream', () => {
    const with_cap = VALID.replace(
      '  namespace: coinmarketcap\n',
      '  namespace: coinmarketcap\n  max_per_call: 0.05 USDC\n',
    );
    const p = parsePolicy(with_cap);
    expect(p.upstreams[0].maxPerCall).toBe(50_000n);
  });

  it('leaves maxPerCall undefined when not specified', () => {
    const p = parsePolicy(VALID);
    expect(p.upstreams[0].maxPerCall).toBeUndefined();
  });

  it('rejects max_per_call > max_per_transaction', () => {
    const bad = VALID.replace(
      '  namespace: coinmarketcap\n',
      '  namespace: coinmarketcap\n  max_per_call: 0.50 USDC\n',
    );
    expect(() => parsePolicy(bad)).toThrow(
      /max_per_call \(\d+\) > max_per_transaction/,
    );
  });

  it('rejects max_per_call == 0 (zero means denied on-chain)', () => {
    const bad = VALID.replace(
      '  namespace: coinmarketcap\n',
      '  namespace: coinmarketcap\n  max_per_call: 0 USDC\n',
    );
    expect(() => parsePolicy(bad)).toThrow(/max_per_call must be > 0/);
  });

  it('rejects an unknown limit key', () => {
    const bad = VALID.replace(
      'daily_limit:         1.00 USDC',
      'hourly_limit: 1.00 USDC',
    );
    expect(() => parsePolicy(bad)).toThrow(/unknown limit "hourly_limit"/);
  });

  it('rejects invalid counterparty address', () => {
    const bad =
      VALID +
      `
## Counterparties
- name: bad
  address: 0xnotanaddress
`;
    expect(() => parsePolicy(bad)).toThrow(/invalid address "0xnotanaddress"/);
  });
});

describe('parsePolicy (limit hierarchy)', () => {
  it('rejects max_per_transaction > daily_limit', () => {
    const bad = VALID.replace(
      'max_per_transaction: 0.10 USDC',
      'max_per_transaction: 2.00 USDC',
    );
    expect(() => parsePolicy(bad)).toThrow(/max_per_transaction.*>.*daily/);
  });

  it('rejects daily > weekly', () => {
    const bad = VALID.replace(
      'weekly_limit:        5.00 USDC',
      'weekly_limit: 0.50 USDC',
    );
    expect(() => parsePolicy(bad)).toThrow(/daily_limit.*>.*weekly_limit/);
  });

  it('rejects weekly > monthly', () => {
    const bad = VALID.replace(
      'monthly_limit:      15.00 USDC',
      'monthly_limit: 2.00 USDC',
    );
    expect(() => parsePolicy(bad)).toThrow(/weekly_limit.*>.*monthly_limit/);
  });
});

describe('parsePolicy (structural)', () => {
  it('rejects an upstream continuation line before any "- name:"', () => {
    const bad = `# Agent Policy
name: cryptonit
chain: base
validity: 30 days
initial_funding: 1.00 USDC

## Limits
max_per_transaction: 0.10 USDC
daily_limit:         1.00 USDC
weekly_limit:        5.00 USDC
monthly_limit:      15.00 USDC

## Upstreams
url: https://mcp.coinmarketcap.com/x402/mcp

## Recovery
drain_to_hub: enabled
`;
    expect(() => parsePolicy(bad)).toThrow(/outside of an upstream entry/);
  });

  it('rejects a dangling field in the header', () => {
    const bad = VALID.replace('name: cryptonit', 'name: cryptonit\nfoo: bar');
    expect(() => parsePolicy(bad)).toThrow(/unknown top-level field "foo"/);
  });
});
