#!/usr/bin/env tsx
// verify-grant/verify.ts
//
// Example counterparty verifier for a Leash authorization grant.
// Pure-crypto path: takes a signed grant JSON file and checks the
// EIP-712 signature against `grant.principal`. For the full
// counterparty flow (hub binding, session-key currency, revocation),
// see summary/authorization-object.md §"Verification".

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyAuthorizationGrantSignature } from '@getleash/core';
import type { SignedAuthorizationGrant } from '@getleash/core';

// Parse BigInt-ish fields that JSON smuggles as strings.
function reviveBigints(key: string, value: unknown): unknown {
  if (
    typeof value === 'string' &&
    (key === 'maxPerTransaction' ||
      key === 'daily' ||
      key === 'weekly' ||
      key === 'monthly')
  ) {
    return BigInt(value);
  }
  return value;
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: verify.ts <signed-grant.json>');
    process.exit(2);
  }

  const raw = readFileSync(resolve(file), 'utf8');
  const signed = JSON.parse(raw, reviveBigints) as SignedAuthorizationGrant;

  const result = await verifyAuthorizationGrantSignature(signed);

  if (!result.ok) {
    console.error(`✗ ${result.reason}`);
    process.exit(1);
  }

  const g = signed.grant;
  console.log('✓ signature valid');
  console.log(`  signer:     ${result.signer}`);
  console.log(`  principal:  ${g.principal}`);
  console.log(`  agent:      ${g.agent}`);
  console.log(`  subAccount: ${g.subAccount}`);
  console.log(`  chain:      ${g.chain}`);
  console.log(`  validUntil: ${new Date(g.validUntil * 1000).toISOString()}`);
  console.log(`  purpose:    ${g.purpose}`);
  console.log(`  limits:`);
  console.log(`    per-tx:  ${g.limits.maxPerTransaction} (USDC base units)`);
  console.log(`    daily:   ${g.limits.daily}`);
  console.log(`    weekly:  ${g.limits.weekly}`);
  console.log(`    monthly: ${g.limits.monthly}`);
  if (g.upstreams.length > 0) {
    console.log(`  upstreams:`);
    for (const u of g.upstreams) {
      console.log(`    - ${u.name}  (${u.url})`);
    }
  }
  if (g.revokedAt !== undefined) {
    console.log(
      `  ⚠ grant revoked at ${new Date(g.revokedAt * 1000).toISOString()} (principal-side only; check on-chain for enforcement)`,
    );
  }
  console.log('');
  console.log(
    'note: this is the offline signature check only. A production counterparty',
  );
  console.log(
    'would additionally verify hub binding + session-key currency via RPC.',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
