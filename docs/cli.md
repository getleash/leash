# CLI reference

> **Audience:** user. Every `leash` command, every flag, every exit code, every error string.

## Synopsis

```
leash <command> [args...]
leash --version
leash --help
```

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Success. |
| 1 | Runtime failure (RPC error, transaction failed, parsing failed, etc.). Stderr has the structured reason. |
| 2 | Usage error (missing required arg, unknown command, missing config). |

Environment variables:

| Variable | Purpose | Default |
|---|---|---|
| `BASE_RPC_URL` | RPC endpoint for Base mainnet (or Base Sepolia for testnet). | `https://mainnet.base.org` (public; fine for getting started; switch to Alchemy/QuickNode for steady-state). |
| `LEASH_KEY_STORE` | Override key-storage backend. `keychain` (macOS only), `file` (everywhere). | `keychain` on macOS, `file` elsewhere. |
| `LEASH_HOME` | Override where Leash stores per-agent state. | `~/Library/Application Support/leash/` on macOS, `~/.leash/` on Linux. |

---

## `leash apply`

Deploy and configure an agent from a policy file. Idempotent — running it on an already-configured agent updates the on-chain state to match the policy.

```
leash apply <policy>.md
```

What it does, in order:

1. Parses the policy file (see [`policy.md`](policy.md)). Errors out with line numbers on any parser issue.
2. Loads or generates the hub-owner key for the policy's `name`. First-time-runs: prints the hub address that needs funding and exits with code 0.
3. Verifies the hub holds at least `initial_funding` USDC. If not: prints the missing amount and exits with code 1.
4. Deploys the hub smart account (if not yet deployed) and the agent's sub-account via CREATE2.
5. Generates a session key (ephemeral, in-memory) and installs the `SessionKeyValidator` on the sub with per-recipient caps drawn from the policy's `## Upstreams` list.
6. Seeds the sub-account with `initial_funding` USDC from the hub.
7. Writes `.mcp.json` in the current directory so Claude Code can launch Leash via stdio.
8. Prints a summary block:

   ```
   Leash: cryptonit ready.
       Hub:        0x40B5…6d0
       Sub:        0xec25…feC2
       Validator:  0xF312…39E3
       Session key expires: 2026-06-15 18:42 UTC
       Sub balance: 1.00 USDC
   ```

Re-running `leash apply` on a configured agent is the **renewal path**. The CLI diffs the on-disk policy against installed state and applies only the changes (new caps, replaced session key, updated validity). See [`policy.md`](policy.md#renewals-and-edits) for what changes are picked up.

**Exit codes:**

- 0 — apply complete, or first-time run that needs funding (the print summarizes what's needed).
- 1 — RPC error, signature failure, on-chain revert, key-store error.
- 2 — policy file missing or unparseable.

**Common errors:**

- `Policy parse error at line N: ...` — see [`policy.md`](policy.md#validation-rules).
- `Hub <addr> needs N.NN USDC to proceed` — fund the hub and rerun.
- `installModule revert (no error data)` — usually means the policy's per-recipient cap install data doesn't match the validator's expected shape; rerun with `LEASH_LOG=debug` for the encoded init data.

---

## `leash serve <agent>`

Start the MCP server for an agent. Claude Code spawns this via `.mcp.json`; you rarely run it by hand.

```
leash serve <agent>
```

The process:

- Reads `~/.leash/<agent>/agent.json` for the sub-account address and policy.
- Decrypts the agent's session key (from macOS Keychain or local file).
- Connects to each upstream's MCP / REST surface.
- Listens on **stdin/stdout** for MCP JSON-RPC frames. Human-readable diagnostics go to stderr only (stdout contamination breaks the MCP frame).

The process stays alive until Claude Code hangs up stdin. `leash serve` is meant to be invoked by Claude Code, not by humans — running it manually shows it waits for MCP frames it'll never receive.

If you need to verify the agent boots cleanly, use `leash doctor` instead.

**Exit codes:**

- 0 — clean shutdown after Claude Code closed stdin.
- 1 — startup failure (config missing, key decrypt failed, upstream connect failed).
- 2 — missing agent argument.

---

## `leash status [agent]`

Show the current state of an agent: sub-account balance, spend so far in each window, session-key expiry.

```
leash status                    # all configured agents
leash status cryptonit          # one agent
```

Output:

```
cryptonit
  Hub:               0x40B5…6d0
  Sub:               0xec25…feC2
  Session key:       active, expires 2026-06-15 18:42 UTC (25 days remaining)
  Sub USDC balance:  0.92 USDC
  Today:             0.08 USDC of 1.00 USDC daily limit
  This week:         0.12 USDC of 5.00 USDC weekly limit
  This month:        0.34 USDC of 15.00 USDC monthly limit
  Upstreams:         coinmarketcap (10 calls), exa (3 calls)
```

`Today` / `This week` / `This month` are computed from the SQLite payment log (`leash.db`). The on-chain balance comes from a live `balanceOf` read.

**Exit codes:**

- 0 — success (even if the agent is misconfigured, partial info is shown with a warning).
- 1 — RPC error during balance read.

---

## `leash logs [agent] [--follow]`

Tail the payment log.

```
leash logs cryptonit            # last 20 entries
leash logs cryptonit --follow   # tail -f equivalent
leash logs cryptonit -n 100     # last 100 entries
```

Each entry shows:

```
2026-05-20 18:33:02  coinmarketcap__get_price       $0.01   ✓ confirmed
2026-05-20 18:35:14  exa__search                    $0.005  ✓ confirmed
2026-05-20 18:41:09  coinmarketcap__get_price       $0.01   ✗ INSUFFICIENT_FUNDS
```

The columns are: ISO timestamp, namespaced tool, USDC amount, status. Failed payments have a code in the status column matching the error envelope (see [`mcp-tools.md`](mcp-tools.md#error-codes)).

**Flags:**

- `--follow` / `-f` — keep tailing as new entries arrive.
- `-n <N>` — show the last N entries (default 20).
- `--since <iso>` — only entries newer than `<iso>` (e.g. `--since 2026-05-20T00:00:00Z`).

---

## `leash fund <agent> <amount>`

Transfer USDC from the hub to the sub-account.

```
leash fund cryptonit 2.00
```

What it does: signs a UserOp from the hub-owner key that transfers `amount` USDC from the hub to the sub. Gas is sponsored by Leash's `VerifyingPaymaster`, so the operator only needs USDC in the hub.

**Exit codes:**

- 0 — funding confirmed on-chain.
- 1 — RPC error, insufficient hub balance, transaction failed.
- 2 — bad amount format (must be `<amount>` like `2.00`, no `USDC` suffix here).

---

## `leash drain <agent>`

Pull **all** USDC from the sub-account back to the hub. The mandatory recovery path — bypasses every per-call and windowed limit.

```
leash drain cryptonit
```

The drain UserOp is signed by the **hub-owner key**, not the agent's session key. The sub-account's session key cannot drain itself — by design. This is your emergency-exit when an agent is misbehaving, the budget shows unexpected spend, or you simply want the funds back without re-applying the agent.

After drain, the agent's sub-account is empty but still configured. To stop the agent from making any future calls, run `leash revoke` next.

**Exit codes:**

- 0 — drain confirmed; sub balance is now 0.
- 1 — RPC error, transaction failed.

---

## `leash revoke <agent>`

Kill the agent's session key on-chain. Atomic — the next call fails at the contract layer with `SESSION_KEY_REVOKED`.

```
leash revoke cryptonit
```

What it does: signs an `uninstallModule` UserOp from the hub-owner key that removes the `SessionKeyValidator` install for this sub-account. After the tx confirms, no signature against that session key will validate, no matter what the proxy or SQLite say.

**Pair with `drain`** when you want both: pull the funds back, then kill the key. Order doesn't matter functionally; the maintainer's recommended order is `drain` first (so the funds are safe before you do anything else), then `revoke`.

To bring the agent back online after a revoke, rerun `leash apply <policy>.md` — Leash generates a fresh session key and reinstalls.

**Exit codes:**

- 0 — revoke confirmed on-chain.
- 1 — RPC error, transaction failed.

---

## `leash doctor [--offline]`

Diagnose common breakages. Reports a structured pass/fail per check.

```
leash doctor                    # full check (includes on-chain reads)
leash doctor --offline          # skip RPC checks
```

Checks include:

1. Node version (≥ 20).
2. `BASE_RPC_URL` set and reachable (skipped with `--offline`).
3. `.leash/` exists for each configured agent and has the expected shape (`agent.json`, `leash.db`).
4. Hub-owner key loads cleanly (Keychain or file).
5. Hub deployed and reachable on-chain (skipped with `--offline`).
6. Sub-account deployed and validator installed (skipped with `--offline`).
7. Session key not yet expired.
8. `.mcp.json` in CWD matches a configured agent (warning, not error, if missing).

Each check prints `✓` or `✗` plus a short reason. Exit code 0 if all pass, 1 if any fail.

**Use it before opening an issue.** Most "Leash doesn't work" reports trace to a doctor-detected mismatch (wrong RPC, expired key, missing `.mcp.json`).

---

## `leash export-backup <path>`

Write an encrypted snapshot of your `.leash/` directory for safekeeping.

```
leash export-backup ~/leash-backup-2026-05-20.lbak
```

The backup is encrypted with **Argon2id (key derivation) + AES-GCM (data)**. Prompts for a passphrase; the same passphrase is needed to restore. Contains:

- Hub-owner private keys (the recoverable identity for each agent's hub).
- Agent configs (`agent.json`).
- Payment logs (`leash.db`).

Does **not** contain session keys — those are ephemeral and re-derivable via `leash apply`.

**Exit codes:**

- 0 — backup written, fsync'd, passphrase verified by a decrypt round-trip.
- 1 — write failure, weak passphrase rejected (< 12 chars).

---

## `leash import-backup <path>`

Restore an encrypted backup into `.leash/`. Refuses to clobber existing state.

```
leash import-backup ~/leash-backup-2026-05-20.lbak
```

Prompts for the passphrase. If `.leash/` already has an agent of the same `name`, the import refuses; you must rename or remove the existing one first. This is intentional — a silent merge of restored backups against current state would be the easiest way to lose funds.

**Exit codes:**

- 0 — restore complete.
- 1 — passphrase wrong, file corrupt, would-clobber check failed.

---

## `leash --version`, `leash --help`, `leash -h`, `leash -v`

```
leash --version
leash --help
```

Prints version (`leash 0.1.0`) or the full command list. `leash` with no args is equivalent to `--help` but exits with code 1 (so shell pipes don't silently succeed on missing args).

---

## Common workflows

### First-time setup

```bash
leash apply cryptonit-policy.md   # generates hub key, prints funding address
# ... send 5 USDC to the printed address ...
leash apply cryptonit-policy.md   # deploys hub + sub, installs validator, seeds sub
```

### Daily check

```bash
leash status cryptonit            # balance + spend windows
leash logs cryptonit -n 10        # last 10 calls
```

### Topping up

```bash
leash fund cryptonit 2.00         # send 2 USDC from hub to sub
```

### Emergency

```bash
leash drain cryptonit             # pull all USDC back to hub
leash revoke cryptonit            # kill the session key on-chain
```

### Backup

```bash
leash export-backup ~/leash-backup-$(date +%F).lbak
# ... store somewhere safe (offline drive, encrypted cloud)
```

### Renew the session key

```bash
# edit cryptonit-policy.md: change validity: 30 days → validity: 90 days
leash apply cryptonit-policy.md   # detects the change, installs a fresh key, revokes the old one
```
