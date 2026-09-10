# DeFi Yield Scanner — where to park stables

**Where can I park my stablecoins right now, and is that yield _real_?**

A **trust filter**, not a yield hunter. It ranks stablecoin yield by _durable, organic,
accessible_ return — high APY is treated as a red flag as often as an opportunity. It is
built as a personal daily tool; the portfolio value is a byproduct of it being genuinely
used and having an explicit opinion.

## The opinion, as data

Two curated maps _are_ the tool's judgment:

- [`build/trusted-protocols.json`](build/trusted-protocols.json) — a hard allowlist. A pool
  whose `project` isn't here does not render. Each entry classifies its `bucket`
  (`lend` / `LP` / `vault`) and `access` (`permissionless` / `permissioned`).
- [`build/trusted-stables.json`](build/trusted-stables.json) — a tiered stable map:
  **1** blue-chip · **2** crypto-backed · **3** synthetic. An LP pool takes the tier of its
  _riskiest_ leg.

## Ranking

- Sort key is **`apyBase`** (organic yield). Rewards are shown but never counted — a
  high-total, mostly-reward pool sits _low_ with a long faint bar tail.
- Fallback when `apyBase` is null: both null → `apy` is organic; reward present → `apy − apyReward`.
- **Durability flag** from spot-vs-30d-mean divergence: `▲` spiking (>+20%) · `●` steady · `▼` decaying (<−20%). Steady is trustworthy.
- Filtered at build: stablecoin only · allowlisted project · all legs mapped · trusted chain
  (Ethereum, Arbitrum, Base, Optimism, Polygon, Solana) · TVL > $1M · not `outlier`.

## Architecture

```
GitHub Action (cron */6h + manual dispatch)
  → GET https://yields.llama.fi/pools
  → filter + classify + compute  (build/pipeline.mjs — pure)
  → write + commit site/data/latest.json  (~small, pre-filtered)
static site (GitHub Pages) reads that JSON — instant load, no key, no backend
```

Commit history of `site/data/latest.json` doubles as free APY-drift history and as proof
the tool has been running.

## Run locally

```bash
node build/build.mjs      # fetch + build site/data/latest.json
npm run serve             # serve ./site at http://localhost:3000
```

## Design

The full grilled design — every resolved decision and the verified data facts — is in
[docs/DESIGN.md](docs/DESIGN.md).

---

_Not investment advice. The rankings encode one person's opinion about trust, deliberately._
