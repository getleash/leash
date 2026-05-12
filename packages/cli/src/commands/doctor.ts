import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  erc20Abi,
  hashPolicyMarkdown,
  leashFactoryAbi,
  sessionKeyValidatorAbi,
  type ChainConfig,
} from '@getleash/core';
import type { Address } from 'viem';
import { listAgentsOnDisk, loadCliRuntime } from '../runtime.js';

// ─── leash doctor ────────────────────────────────────────────────────
//
// Health check. Walks a canonical list of things that go wrong, runs
// each as an individual assertion, and prints one line per row. On-
// chain checks require RPC; `--offline` skips them (useful on flights
// and in CI).

type Status = 'ok' | 'warn' | 'fail';

interface Row {
  name: string;
  status: Status;
  detail?: string;
}

export async function doctor(args: string[]): Promise<number> {
  const offline = args.includes('--offline');
  const rows: Row[] = [];

  const cwd = process.cwd();
  const leashRoot = resolve(cwd, '.leash');

  // ── Local ────────────────────────────────────────────────────
  const configPath = resolve(leashRoot, 'config.json');
  if (!existsSync(configPath)) {
    rows.push({
      name: '.leash/config.json exists',
      status: 'fail',
      detail: 'run `leash apply <policy>.md` to initialize',
    });
    return report(rows);
  }
  rows.push({ name: '.leash/config.json exists', status: 'ok' });

  const agents = listAgentsOnDisk(cwd);
  if (agents.length === 0) {
    rows.push({
      name: 'agents registered',
      status: 'warn',
      detail: 'no agents yet — run `leash apply <policy>.md`',
    });
    return report(rows);
  }
  rows.push({
    name: 'agents registered',
    status: 'ok',
    detail: agents.join(', '),
  });

  // Per-agent checks.
  for (const name of agents) {
    await checkAgent({ name, cwd, leashRoot, offline, rows });
  }

  return report(rows);
}

async function checkAgent(p: {
  name: string;
  cwd: string;
  leashRoot: string;
  offline: boolean;
  rows: Row[];
}): Promise<void> {
  const { name, leashRoot, offline, rows } = p;
  const dir = resolve(leashRoot, 'agent', name);
  const pushFail = (label: string, detail: string) =>
    rows.push({ name: `${name}: ${label}`, status: 'fail', detail });
  const pushOk = (label: string, detail?: string) =>
    rows.push({ name: `${name}: ${label}`, status: 'ok', detail });
  const pushWarn = (label: string, detail: string) =>
    rows.push({ name: `${name}: ${label}`, status: 'warn', detail });

  // ── Load runtime (covers agent.json + grant.json + chain config) ─
  let cli;
  try {
    cli = loadCliRuntime({ agentName: name });
    pushOk('agent.json + grant.json load', cli.runtime.agent.subAccount);
  } catch (e) {
    pushFail('agent.json + grant.json load', (e as Error).message);
    return;
  }

  // ── Session-key expiry vs wallclock ─────────────────────────
  const nowSec = Math.floor(Date.now() / 1000);
  const validUntil = cli.runtime.signedGrant.grant.validUntil;
  if (nowSec > validUntil) {
    pushFail(
      'session key not expired',
      `expired ${new Date(validUntil * 1000).toISOString()}`,
    );
  } else if (validUntil - nowSec < 72 * 3600) {
    pushWarn(
      'session key not expired',
      `expires in ${Math.floor((validUntil - nowSec) / 3600)}h`,
    );
  } else {
    pushOk(
      'session key not expired',
      `expires ${new Date(validUntil * 1000).toISOString()}`,
    );
  }

  // ── Key store: hub owner + agent match registered addresses ──
  try {
    const hubOwner = cli.sessionKeys.loadHubOwnerKey();
    if (hubOwner.address.toLowerCase() !== cli.runtime.hub.owner.toLowerCase()) {
      pushFail(
        'hub-owner key derives correctly',
        `store derives ${hubOwner.address}, config.owner is ${cli.runtime.hub.owner}`,
      );
    } else {
      pushOk('hub-owner key derives correctly');
    }
  } catch (e) {
    pushFail('hub-owner key in store', (e as Error).message);
  }
  try {
    const sessionKey = cli.sessionKeys.loadAgentKey(name);
    if (
      sessionKey.address.toLowerCase() !==
      cli.runtime.agent.sessionKey.toLowerCase()
    ) {
      pushFail(
        'session key derives correctly',
        `store derives ${sessionKey.address}, agent.json says ${cli.runtime.agent.sessionKey}`,
      );
    } else {
      pushOk('session key derives correctly');
    }
  } catch (e) {
    pushFail('session key in store', (e as Error).message);
  }

  // ── Policy hash still matches the stored policy.md ───────────
  const policyMdPath = resolve(dir, 'policy.md');
  if (existsSync(policyMdPath)) {
    const md = readFileSync(policyMdPath, 'utf8');
    const expected = hashPolicyMarkdown(md);
    if (expected === cli.runtime.signedGrant.grant.policyHash) {
      pushOk('policyHash matches .leash/agent/<name>/policy.md');
    } else {
      pushFail(
        'policyHash matches .leash/agent/<name>/policy.md',
        `file hashes to ${expected}, grant says ${cli.runtime.signedGrant.grant.policyHash}`,
      );
    }
  } else {
    pushWarn(
      'policyHash verifiable',
      'policy.md not found alongside grant.json; cannot verify',
    );
  }

  if (offline) return;

  // ── On-chain checks ─────────────────────────────────────────
  const chainConfig = cli.runtime.chainConfig;
  await checkOnChain({
    cli,
    chainConfig,
    rows,
    name,
  });
}

async function checkOnChain(p: {
  cli: ReturnType<typeof loadCliRuntime>;
  chainConfig: ChainConfig;
  rows: Row[];
  name: string;
}): Promise<void> {
  const { cli, chainConfig, rows, name } = p;
  const pushOk = (label: string, detail?: string) =>
    rows.push({ name: `${name}: ${label}`, status: 'ok', detail });
  const pushFail = (label: string, detail: string) =>
    rows.push({ name: `${name}: ${label}`, status: 'fail', detail });
  const pushWarn = (label: string, detail: string) =>
    rows.push({ name: `${name}: ${label}`, status: 'warn', detail });

  const publicClient = cli.publicClient;

  // LeashFactory deployed?
  if (chainConfig.leashFactory === ('0x0000000000000000000000000000000000000000' as Address)) {
    pushWarn('LeashFactory deployed', `not yet deployed on ${chainConfig.name}`);
    return;
  }
  pushOk('LeashFactory deployed', chainConfig.leashFactory);

  // Hub registered on the factory?
  try {
    const onChainHub = (await publicClient.readContract({
      address: chainConfig.leashFactory,
      abi: leashFactoryAbi,
      functionName: 'hubOf',
      args: [cli.runtime.hub.owner],
    })) as Address;
    if (onChainHub.toLowerCase() === cli.runtime.hub.hub.toLowerCase()) {
      pushOk('hub matches on-chain registry');
    } else if (
      onChainHub === '0x0000000000000000000000000000000000000000'
    ) {
      pushWarn(
        'hub matches on-chain registry',
        'hub not yet deployed — rerun `leash apply`',
      );
    } else {
      pushFail(
        'hub matches on-chain registry',
        `config.hub ${cli.runtime.hub.hub}, factory.hubOf ${onChainHub}`,
      );
    }
  } catch (e) {
    pushFail('hub matches on-chain registry', (e as Error).message);
    return;
  }

  // SessionKeyValidator installed on the sub with the right signer?
  if (
    chainConfig.sessionKeyValidator ===
    ('0x0000000000000000000000000000000000000000' as Address)
  ) {
    pushWarn(
      'SessionKeyValidator deployed',
      `not yet deployed on ${chainConfig.name}`,
    );
    return;
  }
  try {
    const session = (await publicClient.readContract({
      address: chainConfig.sessionKeyValidator,
      abi: sessionKeyValidatorAbi,
      functionName: 'sessions',
      args: [cli.runtime.agent.subAccount],
    })) as { signer: Address; validUntil: number; maxValuePerTx: bigint } | readonly [
      Address,
      number,
      bigint,
    ];
    const signer = Array.isArray(session)
      ? (session[0] as Address)
      : (session as { signer: Address }).signer;
    const validUntil = Array.isArray(session)
      ? Number(session[1])
      : (session as { validUntil: number }).validUntil;
    if (signer === '0x0000000000000000000000000000000000000000') {
      pushFail(
        'session-key validator installed',
        `no session registered on sub-account ${cli.runtime.agent.subAccount}`,
      );
    } else if (
      signer.toLowerCase() !== cli.runtime.agent.sessionKey.toLowerCase()
    ) {
      pushFail(
        'session-key validator installed',
        `on-chain signer ${signer} != agent.sessionKey ${cli.runtime.agent.sessionKey} (may have been revoked + reissued)`,
      );
    } else if (validUntil < Math.floor(Date.now() / 1000)) {
      pushFail(
        'session-key validator not expired on-chain',
        `validUntil=${validUntil}`,
      );
    } else {
      pushOk('session-key validator installed on-chain');
    }
  } catch (e) {
    pushFail('session-key validator installed', (e as Error).message);
  }

  // Sub-account USDC balance (info only).
  try {
    const balance = (await publicClient.readContract({
      address: chainConfig.usdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [cli.runtime.agent.subAccount],
    })) as bigint;
    pushOk('sub-account USDC balance', `${balance} base units`);
  } catch (e) {
    pushWarn('sub-account USDC balance', (e as Error).message);
  }
}

function report(rows: Row[]): number {
  let maxName = 0;
  for (const r of rows) maxName = Math.max(maxName, r.name.length);
  for (const r of rows) {
    const tag = r.status === 'ok' ? '  ✓ ' : r.status === 'warn' ? '  ⚠ ' : '  ✗ ';
    const detail = r.detail ? `  — ${r.detail}` : '';
    process.stdout.write(`${tag}${r.name.padEnd(maxName)}${detail}\n`);
  }
  const fails = rows.filter((r) => r.status === 'fail').length;
  const warns = rows.filter((r) => r.status === 'warn').length;
  const summary =
    fails > 0
      ? `\n${fails} fail${fails === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}\n`
      : warns > 0
        ? `\n${warns} warning${warns === 1 ? '' : 's'}\n`
        : `\nall good\n`;
  process.stdout.write(summary);
  return fails > 0 ? 1 : 0;
}

