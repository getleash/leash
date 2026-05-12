// Minimal line-by-line parser for the MVP policy file format. Deliberately
// NOT a markdown AST — user-flows.md promises line-oriented parsing with
// clear errors. For the skeleton we only parse the fields §1.4's fixture
// cares about.

import { readFileSync } from "node:fs";
import { parseUsdc } from "./context.js";

export interface PolicyLimits {
  maxPerTx: bigint;
  daily: bigint;
  weekly: bigint;
  monthly: bigint;
}

export interface PolicyUpstream {
  name: string;
  url: string;
  namespace: string;
}

export interface Policy {
  name: string;
  chain: string;
  validityDays: number;
  initialFunding: bigint;
  limits: PolicyLimits;
  upstreams: PolicyUpstream[];
  drainToHub: boolean;
}

export class PolicyParseError extends Error {}

export function parsePolicyFile(path: string): Policy {
  const text = readFileSync(path, "utf8");
  return parsePolicy(text);
}

export function parsePolicy(text: string): Policy {
  const lines = text.split("\n");
  let name = "";
  let chain = "";
  let validityDays = 0;
  let initialFunding = 0n;
  const limits: PolicyLimits = { maxPerTx: 0n, daily: 0n, weekly: 0n, monthly: 0n };
  const upstreams: PolicyUpstream[] = [];
  let drainToHub = false;

  let section = "";
  let pendingUpstream: Partial<PolicyUpstream> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      // section heading or comment
      const h = line.match(/^##\s+(.*)$/);
      if (h) {
        if (pendingUpstream) {
          upstreams.push(finalizeUpstream(pendingUpstream, i + 1));
          pendingUpstream = null;
        }
        section = h[1].trim().toLowerCase();
        continue;
      }
      continue;
    }

    // Top-level name/chain/validity/initial_funding
    if (line.startsWith("name:")) {
      name = line.slice("name:".length).trim();
      continue;
    }
    if (line.startsWith("chain:")) {
      chain = line.slice("chain:".length).trim();
      continue;
    }
    if (line.startsWith("validity:")) {
      const v = line.slice("validity:".length).trim();
      const m = v.match(/^(\d+)\s+days?$/);
      if (!m) throw new PolicyParseError(`line ${i + 1}: validity must be "<N> days"`);
      validityDays = parseInt(m[1], 10);
      continue;
    }
    if (line.startsWith("initial_funding:")) {
      initialFunding = parseUsdc(line.slice("initial_funding:".length).trim());
      continue;
    }

    if (section === "limits") {
      const m = line.match(/^(\w+):\s*(.+)$/);
      if (!m) throw new PolicyParseError(`line ${i + 1}: expected "field: value"`);
      const [, field, value] = m;
      const v = parseUsdc(value);
      if (field === "max_per_transaction") limits.maxPerTx = v;
      else if (field === "daily_limit") limits.daily = v;
      else if (field === "weekly_limit") limits.weekly = v;
      else if (field === "monthly_limit") limits.monthly = v;
      else throw new PolicyParseError(`line ${i + 1}: unknown limit "${field}"`);
      continue;
    }

    if (section === "upstreams") {
      if (line.startsWith("- name:")) {
        if (pendingUpstream) upstreams.push(finalizeUpstream(pendingUpstream, i + 1));
        pendingUpstream = { name: line.slice("- name:".length).trim() };
        continue;
      }
      const m = line.match(/^(url|namespace):\s*(.+)$/);
      if (m && pendingUpstream) {
        (pendingUpstream as any)[m[1]] = m[2].trim();
        continue;
      }
    }

    if (section === "recovery") {
      if (line.startsWith("drain_to_hub:")) {
        drainToHub = line.slice("drain_to_hub:".length).trim() === "enabled";
        continue;
      }
    }
  }
  if (pendingUpstream) upstreams.push(finalizeUpstream(pendingUpstream, lines.length));

  if (!drainToHub) {
    throw new PolicyParseError(`missing required section "## Recovery" (with drain_to_hub: enabled)`);
  }
  return { name, chain, validityDays, initialFunding, limits, upstreams, drainToHub };
}

function finalizeUpstream(p: Partial<PolicyUpstream>, line: number): PolicyUpstream {
  if (!p.name || !p.url || !p.namespace) {
    throw new PolicyParseError(`line ${line}: upstream missing name/url/namespace`);
  }
  return p as PolicyUpstream;
}
