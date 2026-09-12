# DeFi Yield Scanner — where to park stables

**Where can I park my stablecoins right now, and is that yield _real_?**

A **trust filter**, not a yield hunter. It ranks stablecoin yield by _durable, organic,
accessible_ return — a high APY is treated as a red flag as often as an opportunity. Built
as a personal daily tool; the portfolio value is a byproduct of it being genuinely used and
having an explicit opinion.

**Live:** https://cryptogeadas.github.io/defi-yield-scanner/ · **How it works:** [/methodology.html](site/methodology.html)

## The opinion, as data

The tool's judgment lives in a handful of curated files under `build/`:

- [`trusted-protocols.json`](build/trusted-protocols.json) — a hard allowlist. A pool whose
  `project` isn't here does not render. Each entry sets its `bucket` (`lend`/`LP`/`vault`) and
  `access` (`permissionless`/`permissioned`).
- [`trusted-stables.json`](build/trusted-stables.json) — every trusted stable → `{ tier, type }`:
  - **tier** (risk): 1 blue-chip · 2 crypto-backed · 3 synthetic
  - **type** (backing): `fiat` · `crypto` · `yield` (staked/wrapped) · `rwa` · `synthetic`
  - A multi-asset pool takes the tier **and** type of its _riskiest_ leg.
- [`protocol-names.json`](build/protocol-names.json) — display names per protocol slug.

## Ranking & display

- **Sort key = organic base APY** (`apyBase`, with a fallback ladder). Rewards are shown but
  never counted — a high-total, mostly-reward pool sits _low_ with a long faint bar tail.
- **LP/DEX pools** lead with the **conservative `min(current spot, 30-day mean)`** instead of
  the spot fee-APY (which is ~24h-volume-annualized and swings hard). The headline never
  overstates today's rate; the live spot is shown in the row's detail panel.
- **Durability flag** from spot-vs-30d-mean divergence: `▲` spiking (>+20%) · `●` steady ·
  `▼` decaying (<−20%). Steady is trustworthy.
- **Three risk tiers** shown as stacked windows; filter by **bucket**, **stable type**, and
  **chain**; sort by any column; permissioned (🔒 KYC) rows hidden by default. Rows paginate
  15 at a time with "Load more".
- Click a row for a detail panel (APY breakdown, durability sentence, risk, size, composition)
  and the deposit link.

## Deposit links (per row)

Resolved at build in priority order (see [`build/deeplinks.mjs`](build/deeplinks.mjs)):

1. **Manual override** — [`pool-urls.json`](build/pool-urls.json), pool-id → exact URL (wins over all).
2. **Exact, computed/looked-up** — Aave V3, Curve, Uniswap V3 (CREATE2), and Morpho vaults
   (resolved via the Morpho API in [`deeplink-sources.mjs`](build/deeplink-sources.mjs)).
3. **Protocol's own app** (from DefiLlama's config URL) when no exact link is derivable.
4. **DefiLlama pool page** as a last resort. Permissioned rows are unlinked.

## Coverage & liveness

- **Vault surfacing:** MetaMorpho vaults are listed by DefiLlama under a share symbol
  (`STEAKUSDC`) our stable filter would drop; the build resolves them to their underlying
  asset + exact URL so they appear and tier correctly. (See [`docs/COVERAGE-TODO.md`](docs/COVERAGE-TODO.md).)
- **Liveness filter:** drops dead LP pools (7-day volume < $25k) and zero-yield pools.
- **Denylist:** [`denylist.json`](build/denylist.json) hides deprecated-but-functional venues
  the data can't detect — by pool id, `project|chain|SYMBOL`, or Morpho vault address.
- **Sanity floor:** the build refuses to overwrite the snapshot if a partial feed keeps <100 pools.

## Architecture

```
GitHub Action (cron */6h + manual dispatch)
  → GET https://yields.llama.fi/pools  (+ Curve / Morpho APIs for exact links & vault surfacing)
  → filter + classify + compute  (build/pipeline.mjs — pure, portable)
  → write + commit site/data/latest.json (small, pre-filtered) + vendored logos
static site (GitHub Pages) reads that JSON — instant load, no key, no backend
```

Commit history of `site/data/latest.json` doubles as free APY-drift history and proof the
tool has been running. A second workflow deploys `site/` to Pages on every change.

## Run locally

```bash
npm ci                 # installs the one build-only dep (js-sha3, for Uniswap CREATE2)
node build/build.mjs   # fetch + build site/data/latest.json + vendor logos
npm run serve          # serve ./site at http://localhost:3000
```

## Design

The full grilled design — every resolved decision and the verified data facts — is in
[docs/DESIGN.md](docs/DESIGN.md).

---

_Not investment advice. The rankings encode one person's opinion about trust, deliberately._
