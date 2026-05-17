# Agent Policy
name: multi-upstream
chain: base
validity: 30 days
initial_funding: 1.00 USDC

## Limits
max_per_transaction: 0.15 USDC
daily_limit:         1.00 USDC
weekly_limit:        5.00 USDC
monthly_limit:     15.00 USDC

## Upstreams
- name: coinmarketcap
  url:       https://mcp.coinmarketcap.com/x402/mcp
  namespace: coinmarketcap

- name: exa
  url:       https://api.exa.ai
  namespace: exa

- name: neynar
  url:       https://api.neynar.com
  namespace: neynar

- name: gloria
  url:       https://api.itsgloria.ai
  namespace: gloria

- name: orac
  url:       https://orac-safety.orac.workers.dev
  namespace: orac

- name: agoragentic
  url:       https://x402.agoragentic.com
  namespace: agoragentic

- name: invy
  url:       https://invy.bot
  namespace: invy

- name: azursafe
  url:       https://ai.azursafe.com
  namespace: azursafe

- name: ottoai
  url:       https://x402.ottoai.services
  namespace: ottoai

- name: donate-0000402
  url:       https://donate.0000402.xyz
  namespace: donate-0000402

## Recovery
# The hub owner can always drain this sub-account back to the hub,
# bypassing all limits above. This is your emergency exit.
drain_to_hub: enabled
