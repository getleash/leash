# Agent Policy
name: cryptonit
chain: base
validity: 30 days
initial_funding: 1.00 USDC

## Limits
max_per_transaction: 0.10 USDC
daily_limit:         1.00 USDC
weekly_limit:        5.00 USDC
monthly_limit:      15.00 USDC

## Upstreams
- name: coinmarketcap
  url:       https://mcp.coinmarketcap.com/x402/mcp
  namespace: coinmarketcap
  # Optional per-upstream amount cap, enforced on-chain. Without it,
  # max_per_transaction (0.10 USDC) doubles as the per-call cap.
  # max_per_call: 0.02 USDC

## Recovery
# The hub owner can always drain this sub-account back to the hub,
# bypassing all limits above. This is your emergency exit.
drain_to_hub: enabled

## Counterparties (optional, for the `transfer` tool)
# - name: monthly-invoice
#   address: 0xabc123...
