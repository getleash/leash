// File-backed state for the skeleton: .leash/config.json, .leash/agent.json,
// and .mcp.json at the repo root. Writes are real; reads are real; the
// orchestrator just points cwd at a temp directory.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "./context.js";

export interface LeashConfig {
  hub: string;
  createdAt: string;
}

export interface AgentConfig {
  name: string;
  hub: string;
  subAccount: string;
  sessionKey: {
    address: string;
    validUntil: string; // ISO
  };
  upstreams: Array<{ name: string; url: string; namespace: string; recipient: string }>;
  initialFundingBase: string; // bigint serialized
  dailyLimitBase: string;
  weeklyLimitBase: string;
  monthlyLimitBase: string;
  maxPerTxBase: string;
}

function leashDir(ctx: Context): string {
  const dir = join(ctx.cwd, ".leash");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function configPath(ctx: Context): string {
  return join(leashDir(ctx), "config.json");
}
export function agentPath(ctx: Context): string {
  return join(leashDir(ctx), "agent.json");
}
export function mcpJsonPath(ctx: Context): string {
  return join(ctx.cwd, ".mcp.json");
}
export function logPath(ctx: Context): string {
  return join(leashDir(ctx), "leash.log");
}

export function hasConfig(ctx: Context): boolean {
  return existsSync(configPath(ctx));
}
export function readConfig(ctx: Context): LeashConfig {
  return JSON.parse(readFileSync(configPath(ctx), "utf8"));
}
export function writeConfig(ctx: Context, cfg: LeashConfig) {
  writeFileSync(configPath(ctx), JSON.stringify(cfg, null, 2) + "\n");
}

export function hasAgent(ctx: Context): boolean {
  return existsSync(agentPath(ctx));
}
export function readAgent(ctx: Context): AgentConfig {
  return JSON.parse(readFileSync(agentPath(ctx), "utf8"));
}
export function writeAgent(ctx: Context, a: AgentConfig) {
  writeFileSync(agentPath(ctx), JSON.stringify(a, null, 2) + "\n");
}

export function writeMcpJson(ctx: Context, agentName: string) {
  const obj = {
    mcpServers: {
      leash: {
        command: "leash",
        args: ["serve", agentName],
      },
    },
  };
  writeFileSync(mcpJsonPath(ctx), JSON.stringify(obj, null, 2) + "\n");
}

export function appendLog(ctx: Context, line: string) {
  const p = logPath(ctx);
  const existing = existsSync(p) ? readFileSync(p, "utf8") : "";
  writeFileSync(p, existing + line);
}
