import { describe, expect, it } from 'vitest';
import { COMMANDS, findCommand, renderHelp } from '../src/dispatcher.js';

describe('COMMANDS table', () => {
  it('includes every Phase-7 command', () => {
    const names = COMMANDS.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        'apply',
        'doctor',
        'drain',
        'export-backup',
        'fund',
        'import-backup',
        'logs',
        'revoke',
        'serve',
        'status',
      ].sort(),
    );
  });

  it('all Phase-7 commands are available (Phase 7d closes the surface)', () => {
    const ready = COMMANDS.filter((c) => c.available).map((c) => c.name).sort();
    expect(ready).toEqual([
      'apply',
      'doctor',
      'drain',
      'export-backup',
      'fund',
      'import-backup',
      'logs',
      'revoke',
      'serve',
      'status',
    ]);
    const pending = COMMANDS.filter((c) => !c.available).map((c) => c.name);
    expect(pending).toEqual([]);
  });

  it('every command has a non-empty synopsis and usage', () => {
    for (const c of COMMANDS) {
      expect(c.synopsis).toBeTruthy();
      expect(c.usage).toContain('leash');
    }
  });
});

describe('findCommand', () => {
  it('returns the command object by name', () => {
    expect(findCommand('serve')?.name).toBe('serve');
  });
  it('returns undefined for unknown names', () => {
    expect(findCommand('wat')).toBeUndefined();
  });
});

describe('renderHelp', () => {
  const help = renderHelp();

  it('lists every Phase-7 command without the (soon) marker', () => {
    expect(help).toMatch(/^\s*serve\s/m);
    expect(help).toMatch(/^\s*status\s/m);
    expect(help).toMatch(/^\s*fund\s/m);
    expect(help).toMatch(/^\s*doctor\s/m);
    expect(help).toMatch(/^\s*export-backup\s/m);
    expect(help).toMatch(/^\s*import-backup\s/m);
    expect(help).not.toMatch(/\(soon\)/);
  });

  it('documents the LEASH_* env vars', () => {
    expect(help).toContain('LEASH_BASE_RPC');
    expect(help).toContain('LEASH_KEY_STORE=file');
  });
});
