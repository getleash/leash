#!/usr/bin/env tsx
// Sync Phase-8 deployed addresses into @getleash/core/src/constants.ts.
//
// Usage (two modes):
//
//   A. Direct address args (fastest, post-`forge script`):
//      npx tsx scripts/sync-deployments.ts \
//        --chain base \
//        --factory 0xABC... \
//        --validator 0xDEF... \
//        --paymaster 0x123...
//
//   B. Read from Foundry broadcast output:
//      npx tsx scripts/sync-deployments.ts \
//        --chain base \
//        --broadcast contracts/broadcast/DeployLeash.s.sol/8453/run-latest.json
//
// Updates BASE_MAINNET (chain=base) or BASE_SEPOLIA (chain=base-sepolia)
// inside packages/core/src/constants.ts. Refuses to proceed on empty /
// zero addresses — catches copy-paste fumbles before they land.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CONSTANTS_PATH = resolve(REPO_ROOT, 'packages/core/src/constants.ts');

type Chain = 'base' | 'base-sepolia';

interface Addresses {
  // Leash contracts (always synced).
  factory: `0x${string}`;
  validator: `0x${string}`;
  paymaster: `0x${string}`;
  // Upstream ZeroDev contracts (synced when freshly deployed by the
  // script; left undefined when the operator passed a pre-existing
  // address via env override — in which case constants.ts already
  // has the right value or the operator updates manually).
  kernelFactory?: `0x${string}`;
  kernelImpl?: `0x${string}`;
  ecdsaValidator?: `0x${string}`;
}

function parseArgs(argv: string[]): {
  chain: Chain;
  addresses: Addresses;
} {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) {
      throw new Error(`--${k.slice(2)} requires a value`);
    }
    args.set(k.slice(2), v);
    i++;
  }

  const chain = args.get('chain') as Chain | undefined;
  if (chain !== 'base' && chain !== 'base-sepolia') {
    throw new Error('--chain must be "base" or "base-sepolia"');
  }

  const broadcast = args.get('broadcast');
  if (broadcast) {
    return { chain, addresses: addressesFromBroadcast(broadcast) };
  }

  return { chain, addresses: addressesFromArgs(args) };
}

function addressesFromArgs(args: Map<string, string>): Addresses {
  const factory = requireAddress(args.get('factory'), '--factory');
  const validator = requireAddress(args.get('validator'), '--validator');
  const paymaster = requireAddress(args.get('paymaster'), '--paymaster');
  return {
    factory,
    validator,
    paymaster,
    kernelFactory: optionalAddress(args.get('kernel-factory'), '--kernel-factory'),
    kernelImpl: optionalAddress(args.get('kernel-impl'), '--kernel-impl'),
    ecdsaValidator: optionalAddress(args.get('ecdsa-validator'), '--ecdsa-validator'),
  };
}

function addressesFromBroadcast(path: string): Addresses {
  const abs = resolve(REPO_ROOT, path);
  if (!existsSync(abs)) {
    throw new Error(`broadcast JSON not found at ${abs}`);
  }
  const raw = JSON.parse(readFileSync(abs, 'utf8')) as {
    transactions?: Array<{
      contractName?: string;
      contractAddress?: string;
      transactionType?: string;
    }>;
  };

  const byName = (name: string): `0x${string}` => {
    const tx = raw.transactions?.find(
      (t) => t.transactionType === 'CREATE' && t.contractName === name,
    );
    if (!tx?.contractAddress) {
      throw new Error(
        `no CREATE tx for ${name} in ${path} — did forge script fail?`,
      );
    }
    return requireAddress(tx.contractAddress, name);
  };

  // Optional — present only if DeployLeash actually deployed this
  // contract (vs reusing an env-supplied existing one).
  const byNameOptional = (name: string): `0x${string}` | undefined => {
    const tx = raw.transactions?.find(
      (t) => t.transactionType === 'CREATE' && t.contractName === name,
    );
    if (!tx?.contractAddress) return undefined;
    return requireAddress(tx.contractAddress, name);
  };

  return {
    factory: byName('LeashFactory'),
    validator: byName('SessionKeyValidator'),
    paymaster: byName('VerifyingPaymaster'),
    kernelFactory: byNameOptional('KernelFactory'),
    kernelImpl: byNameOptional('Kernel'),
    ecdsaValidator: byNameOptional('ECDSAValidator'),
  };
}

function requireAddress(v: string | undefined, label: string): `0x${string}` {
  if (!v) throw new Error(`missing address for ${label}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new Error(`invalid address for ${label}: "${v}"`);
  }
  if (/^0x0+$/.test(v)) {
    throw new Error(`refusing to write the zero address for ${label}`);
  }
  return v as `0x${string}`;
}

function optionalAddress(
  v: string | undefined,
  label: string,
): `0x${string}` | undefined {
  if (v === undefined) return undefined;
  return requireAddress(v, label);
}

// ─── Constants.ts surgery ────────────────────────────────────────────

function updateConstants(chain: Chain, addrs: Addresses): void {
  const src = readFileSync(CONSTANTS_PATH, 'utf8');
  const blockName = chain === 'base' ? 'BASE_MAINNET' : 'BASE_SEPOLIA';

  // Find `export const BASE_MAINNET: ChainConfig = { ... };`
  const blockRe = new RegExp(
    `(export const ${blockName}: ChainConfig = \\{)([\\s\\S]*?)(\\n\\};)`,
  );
  const match = src.match(blockRe);
  if (!match) {
    throw new Error(
      `could not locate '${blockName}' block in ${CONSTANTS_PATH}`,
    );
  }

  let body = match[2];
  body = replaceField(body, 'leashFactory', addrs.factory);
  body = replaceField(body, 'sessionKeyValidator', addrs.validator);
  body = replaceField(body, 'verifyingPaymaster', addrs.paymaster);
  if (addrs.kernelFactory) {
    body = replaceField(body, 'kernelFactory', addrs.kernelFactory);
  }
  if (addrs.kernelImpl) {
    body = replaceField(body, 'kernelImpl', addrs.kernelImpl);
  }
  if (addrs.ecdsaValidator) {
    body = replaceField(body, 'ecdsaValidator', addrs.ecdsaValidator);
  }

  const updated = src.replace(blockRe, `$1${body}$3`);
  writeFileSync(CONSTANTS_PATH, updated);
}

function replaceField(body: string, field: string, value: string): string {
  // Matches either a quoted hex literal (post-sync state) or a bare
  // identifier like `ZERO` (pre-deploy default). Preserves the
  // trailing comma if present.
  const re = new RegExp(`(${field}:\\s*)(?:'0x[0-9a-fA-F]+'|[A-Z_][A-Z0-9_]*)(,?)`);
  if (!re.test(body)) {
    throw new Error(`field '${field}' not found in chain config body`);
  }
  return body.replace(re, `$1'${value}'$2`);
}

// ─── entrypoint ──────────────────────────────────────────────────────

try {
  const { chain, addresses } = parseArgs(process.argv.slice(2));
  updateConstants(chain, addresses);
  console.log(`Updated ${CONSTANTS_PATH} for chain ${chain}:`);
  console.log(`  leashFactory:        ${addresses.factory}`);
  console.log(`  sessionKeyValidator: ${addresses.validator}`);
  console.log(`  verifyingPaymaster:  ${addresses.paymaster}`);
  if (addresses.kernelFactory) {
    console.log(`  kernelFactory:       ${addresses.kernelFactory}`);
  }
  if (addresses.kernelImpl) {
    console.log(`  kernelImpl:          ${addresses.kernelImpl}`);
  }
  if (addresses.ecdsaValidator) {
    console.log(`  ecdsaValidator:      ${addresses.ecdsaValidator}`);
  }
  console.log('');
  console.log(
    'Next steps: `npm run build -w @getleash/core`, run tests, commit.',
  );
} catch (e) {
  console.error(`sync-deployments: ${(e as Error).message}`);
  process.exit(1);
}
