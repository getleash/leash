import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

// ─── Temp-.leash fixture helpers ─────────────────────────────────────
//
// CLI commands read `.leash/config.json` + `.leash/agent/<name>/*`.
// Each test creates a fresh temp .leash with the canonical shape
// and can point commands at it via cwd.

const TEST_HUB_OWNER_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_SESSION_PK =
  '0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc67e1e3c5ff32c9e7fd38b33';

export interface LeashFixture {
  root: string;
  leashRoot: string;
  hubOwnerAddress: `0x${string}`;
  sessionKeyAddress: `0x${string}`;
  subAccount: `0x${string}`;
  hub: `0x${string}`;
  agentName: string;
  grantId: string;
}

export function makeLeashFixture(
  opts: { agentName?: string; chain?: 'base' | 'base-sepolia' } = {},
): LeashFixture {
  const agentName = opts.agentName ?? 'cryptonit';
  const chain = opts.chain ?? 'base';
  const root = mkdtempSync(resolve(tmpdir(), 'leash-cli-'));
  const leashRoot = resolve(root, '.leash');
  mkdirSync(resolve(leashRoot, 'agent', agentName), { recursive: true });

  const hubOwner = privateKeyToAccount(TEST_HUB_OWNER_PK);
  const sessionKey = privateKeyToAccount(TEST_SESSION_PK);
  const hub = '0x0000000000000000000000000000000000000111' as const;
  const subAccount = '0x0000000000000000000000000000000000000222' as const;
  const grantId = '0199c0de-0000-7000-8000-000000000001';

  writeFileSync(
    resolve(leashRoot, 'config.json'),
    JSON.stringify({ owner: hubOwner.address, hub, chain }, null, 2),
  );
  writeFileSync(
    resolve(leashRoot, 'hub-owner.json'),
    JSON.stringify({ privateKey: TEST_HUB_OWNER_PK, address: hubOwner.address }),
  );
  writeFileSync(
    resolve(leashRoot, 'agent', agentName, 'agent.json'),
    JSON.stringify(
      {
        name: agentName,
        subAccount,
        sessionKey: sessionKey.address,
        policyPath: resolve(root, `${agentName}-policy.md`),
      },
      null,
      2,
    ),
  );
  writeFileSync(
    resolve(leashRoot, 'agent', agentName, 'session-key.json'),
    JSON.stringify({ privateKey: TEST_SESSION_PK, address: sessionKey.address }),
  );
  writeFileSync(
    resolve(leashRoot, 'agent', agentName, 'grant.json'),
    JSON.stringify(
      {
        grant: {
          id: grantId,
          principal: hubOwner.address,
          agent: sessionKey.address,
          subAccount,
          chain,
          validFrom: 1_700_000_000,
          validUntil: 2_000_000_000,
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
          policyHash: ('0x' + 'ab'.repeat(32)) as Hex,
        },
        signature: ('0x' + 'cd'.repeat(65)) as Hex,
      },
      null,
      2,
    ),
  );

  return {
    root,
    leashRoot,
    hubOwnerAddress: hubOwner.address,
    sessionKeyAddress: sessionKey.address,
    subAccount,
    hub,
    agentName,
    grantId,
  };
}

/** Capture process.stdout + process.stderr over an async body. */
export async function captureStdio<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string; stderr: string }> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let stdout = '';
  let stderr = '';
  (process.stdout as unknown as { write: typeof origOut }).write = ((
    chunk: string | Uint8Array,
  ) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof origOut;
  (process.stderr as unknown as { write: typeof origErr }).write = ((
    chunk: string | Uint8Array,
  ) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof origErr;
  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    (process.stdout as unknown as { write: typeof origOut }).write = origOut;
    (process.stderr as unknown as { write: typeof origErr }).write = origErr;
  }
}
