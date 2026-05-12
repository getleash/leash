#!/usr/bin/env tsx
// Sync ABIs from contracts/out/*.json into packages/core/src/abis/*.ts.
//
// Run after `forge build` in contracts/ whenever a Leash contract or a
// vendored Kernel contract changes. Overwrites the existing file(s)
// verbatim — commit after running so the regeneration is reviewable.
//
//   npx tsx scripts/sync-abis.ts
//
// Intentionally minimal — no npm deps beyond Node's built-ins. Lives
// alongside other scripts rather than inside @getleash/core because it's
// dev-time tooling, not a runtime dep.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(REPO_ROOT, 'contracts', 'out');
const ABIS_DIR = resolve(REPO_ROOT, 'packages', 'core', 'src', 'abis');

interface Source {
  /** Foundry output file, relative to contracts/out/. */
  artifact: string;
  /** Target TS filename in packages/core/src/abis/. */
  target: string;
  /** Exported const name. */
  exportName: string;
  /** Human-readable description embedded in the file header. */
  description: string;
}

const SOURCES: Source[] = [
  {
    artifact: 'Kernel.sol/Kernel.json',
    target: 'kernel.ts',
    exportName: 'kernelAbi',
    description: 'Kernel v3.3 (ZeroDev) — modular ERC-7579 smart account.',
  },
  {
    artifact: 'LeashFactory.sol/LeashFactory.json',
    target: 'leash-factory.ts',
    exportName: 'leashFactoryAbi',
    description:
      'LeashFactory — our thin wrapper over KernelFactory; hub+sub registry.',
  },
  {
    artifact: 'SessionKeyValidator.sol/SessionKeyValidator.json',
    target: 'session-key-validator.ts',
    exportName: 'sessionKeyValidatorAbi',
    description:
      'SessionKeyValidator — non-root ERC-7579 validator for session keys.',
  },
  {
    artifact: 'ECDSAValidator.sol/ECDSAValidator.json',
    target: 'ecdsa-validator.ts',
    exportName: 'ecdsaValidatorAbi',
    description: 'ZeroDev ECDSAValidator — root validator for hub + sub.',
  },
];

function sync(source: Source): void {
  const artifactPath = resolve(OUT_DIR, source.artifact);
  if (!existsSync(artifactPath)) {
    throw new Error(
      `Missing ${artifactPath}. Run \`forge build\` in contracts/ first.`,
    );
  }
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  if (!Array.isArray(artifact.abi)) {
    throw new Error(`${artifactPath} has no abi[] field.`);
  }
  const abiJson = JSON.stringify(artifact.abi, null, 2);
  const targetPath = resolve(ABIS_DIR, source.target);
  const content = `// ${source.description}
//
// Auto-generated from contracts/out/${source.artifact} by
// scripts/sync-abis.ts. Do NOT edit by hand — rerun the script after
// \`forge build\` instead.

export const ${source.exportName} = ${abiJson} as const;
`;
  mkdirSync(ABIS_DIR, { recursive: true });
  writeFileSync(targetPath, content);
  console.log(
    `  ✓ ${source.target.padEnd(28)} (${artifact.abi.length} entries)`,
  );
}

console.log('Syncing ABIs from contracts/out/ → packages/core/src/abis/');
for (const s of SOURCES) sync(s);
console.log('Done. Remember to update packages/core/src/abis/index.ts barrel.');
