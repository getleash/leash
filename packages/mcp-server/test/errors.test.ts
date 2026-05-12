import { describe, expect, it } from 'vitest';
import {
  buildMcpError,
  configMissing,
  notYetImplemented,
  sessionKeyExpired,
} from '../src/errors.js';

describe('buildMcpError', () => {
  it('produces the canonical structured envelope (errors.md §1)', () => {
    const e = buildMcpError({
      code: 'INSUFFICIENT_FUNDS',
      category: 'funds',
      text: 'not enough usdc',
      details: { balance_usdc: '0.00', required_usdc: '0.10' },
      suggested_action: 'leash fund cryptonit 1.00',
    });
    expect(e.isError).toBe(true);
    expect(e.content).toEqual([{ type: 'text', text: 'not enough usdc' }]);
    expect(e.structuredContent).toEqual({
      code: 'INSUFFICIENT_FUNDS',
      category: 'funds',
      details: { balance_usdc: '0.00', required_usdc: '0.10' },
      suggested_action: 'leash fund cryptonit 1.00',
    });
  });

  it('refuses to build an error without a suggested_action (errors.md §4)', () => {
    expect(() =>
      buildMcpError({
        code: 'UPSTREAM_UNAVAILABLE',
        category: 'upstream',
        text: 'x',
        details: {},
        suggested_action: '',
      }),
    ).toThrow(/suggested_action is mandatory/);
  });
});

describe('configMissing', () => {
  it('matches the errors.md §1 catalogue row for CONFIG_MISSING', () => {
    const e = configMissing('cryptonit');
    expect(e.structuredContent.code).toBe('CONFIG_MISSING');
    expect(e.structuredContent.category).toBe('config');
    expect(e.structuredContent.details).toEqual({ agent: 'cryptonit' });
    expect(e.structuredContent.suggested_action).toContain('leash apply');
    expect(e.structuredContent.suggested_action).toContain('leash status');
    expect(e.content[0].text).toContain('cryptonit');
  });
});

describe('sessionKeyExpired', () => {
  it('uses auth category and includes the expiry time', () => {
    const e = sessionKeyExpired('cryptonit', '2026-04-20 12:00');
    expect(e.structuredContent.code).toBe('SESSION_KEY_EXPIRED');
    expect(e.structuredContent.category).toBe('auth');
    expect(e.content[0].text).toContain('2026-04-20 12:00');
    expect(e.structuredContent.suggested_action).toBe(
      'leash apply cryptonit-policy.md',
    );
  });
});

describe('notYetImplemented', () => {
  it('returns a CONFIG_MISSING structured error that names the phase', () => {
    const e = notYetImplemented('transfer', 'Phase 6b');
    expect(e.structuredContent.code).toBe('CONFIG_MISSING');
    expect(e.structuredContent.details).toEqual({
      tool: 'transfer',
      phase: 'Phase 6b',
    });
    expect(e.content[0].text).toContain('Phase 6b');
    expect(e.content[0].text).toContain('transfer');
  });
});
