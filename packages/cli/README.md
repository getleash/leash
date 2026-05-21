# @getleash/cli

The `leash` command. Apply policies, deploy hub/sub-accounts, fund and drain USDC on Base, kill session keys on-chain.

Part of [Leash](https://getleash.dev) — a scoped wallet for AI agents that pay for APIs.

## Install

```bash
npm install -g @getleash/cli
leash --version    # leash 0.1.0
```

## Quickstart

```bash
# In your agent's repo
cp <leash-repo>/examples/cryptonit/cryptonit-policy.md ./
cp <leash-repo>/examples/cryptonit/CLAUDE.md           ./

# First run: generates the hub-owner key, prints the funding address
leash apply cryptonit-policy.md

# Send ~5 USDC on Base to the printed address (~30s), then rerun:
leash apply cryptonit-policy.md

# Open Claude Code in this directory.
# Cryptonit can now pay per-call within the policy's limits.
```

## Commands

```
leash apply <policy>.md           # deploy + configure an agent from a policy file
leash serve <agent>               # MCP stdio server (Claude Code spawns this)
leash status [agent]              # balance, spend windows, session-key expiry
leash logs [agent] [--follow]     # tail the payment log
leash fund <agent> <amount>       # top up a sub from the hub
leash drain <agent>               # pull all USDC back to the hub
leash revoke <agent>              # kill the session key on-chain
leash doctor [--offline]          # diagnose common breakages
leash export-backup <path>        # encrypted snapshot of .leash/
leash import-backup <path>        # restore an encrypted backup
```

Full reference (flags, env vars, exit codes, error strings): **[getleash.dev](https://getleash.dev)** — or the `docs/cli.md` page in [github.com/getleash/leash](https://github.com/getleash/leash).

## License

MIT © Stepan Kouba and Leash contributors.
