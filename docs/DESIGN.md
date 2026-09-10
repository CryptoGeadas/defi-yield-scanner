# 01 — DeFi Yield Scanner (Stablecoin Parking)

**Status:** GRILLED & RESOLVED 2026-09-09 · endpoint verified live
**Difficulty:** easy · **Time to first result:** immediate · **Scope:** ~1 day
**Role in batch:** this repo establishes the reusable pattern for tools #2–#7.

---

## The decision this tool serves

**"Where can I park my stables right now, and is that yield real?"**
It is a *trust filter*, not a yield-hunter. Ranking rewards durable, organic,
accessible yield — high APY is treated as a red flag as often as an opportunity.
Built as a **personal daily tool**; portfolio value is a byproduct of it being
genuinely used + having an explicit opinion, not of UI gloss.

## Resolved decisions

| # | Decision | Resolution |
|---|---|---|
| Framing | park vs hunt | **Park stables / trust filter** |
| Audience | daily vs showpiece | **Daily tool**; polish comes free |
| Asset scope | stables vs LSTs | **Stablecoin-only** |
| Buckets | how stables earn | **lend / LP / vault** (column within each window) |
| Protocol trust | allowlist vs show-all | **Curated `trusted-protocols.json`** = hard allowlist + classifier |
| Stable trust | gate the asset | **Tiered `trusted-stables.json`**: blue-chip / crypto-backed / synthetic |
| Layout | how axes combine | **Tier = 3 stacked windows on one screen**; bucket = column/filter within |
| Access | RWA/permissioned | **Permissionless default**; permissioned = opt-in collapsed window (`🔒 KYC`) |
| Sort key | which APY | **`apyBase` (organic)** by default; rewards loud but not counted |
| Durability | is it real *today* | **`apyMean30d` column + spot-vs-mean divergence flag** |
| Architecture | static vs Action | **Action → commit JSON → static reads it** (the batch pattern) |
| Chains | which | **Ethereum, Arbitrum, Base, Optimism, Polygon, Solana** |
| TVL floor | ghost pools | **$1M** + drop `outlier === true` |
| Cadence | freshness | **6-hour cron** + `workflow_dispatch` |
| Bar | absolute vs normalized | **Absolute** (length = total APY, split base\|reward) |
| Excluded v1 | — | Pendle; live peg checks (tool #7); reward-token quality (v2); per-pool `/chart` (v2) |

## The two curated maps (the tool's opinion, as data)

**`trusted-protocols.json`** — membership = trust; each entry classifies:
```json
{ "aave-v3":     { "bucket": "lend",  "access": "permissionless" },
  "morpho-blue": { "bucket": "lend",  "access": "permissionless" },
  "curve-dex":   { "bucket": "LP",    "access": "permissionless" },
  "yearn-finance":{ "bucket": "vault","access": "permissionless" },
  "blackrock-buidl": { "bucket": "lend", "access": "permissioned" } }
```
A pool whose `project` isn't in the map **does not render**. Solana projects
(kamino-lend, jupiter-lend, marginfi, orca-dex…) need entries too.

**`trusted-stables.json`** — assigns each stable to a tier:
- **Tier 1 blue-chip:** USDC, USDT, DAI
- **Tier 2 crypto-backed:** crvUSD, GHO, LUSD, sDAI, USDS
- **Tier 3 synthetic:** USDe, and friends (own window, opt-in feel)

**LP pools take the tier of their *riskiest* leg.** A USDC/USDe pool → Tier 3.

## Ranking logic

1. Filter at build: `stablecoin === true` → project in allowlist → all legs in
   stable map → chain in allowlist → `tvlUsd > 1e6` → `outlier !== true`.
2. **Organic-yield sort key** with fallback:
   - `apyBase` present → use it.
   - `apyBase` null AND `apyReward` null → treat `apy` as base (organic).
   - `apyBase` null AND `apyReward` present → `apyBase = apy − apyReward`.
3. Sort each window by that base number, descending. Rewards shown, never counted.
4. **Divergence flag** = `(apy − apyMean30d) / apyMean30d`:
   `▲ spiking` (>+20%) · `● steady` · `▼ decaying` (<−20%). Steady = trustworthy.
5. Ignore DefiLlama `predictions` / `sigma` / `mu` — the opinion stays ours.

## Output — row anatomy (within a tier window)

```
[bucket badge] Protocol · Symbol · Chain | [██████░░░░ base|reward] | apyBase% (sort) | 30d% | ▲/●/▼ | TVL
```
- Absolute bar scaled within the window: solid = base, faint = reward. High-total
  mostly-reward pools sit *low* in the sort with a long faint tail — the thesis, drawn.
- Permissioned window adds a loud `🔒 KYC` badge; absent everywhere else.
- One-click re-sort by total / 30d for deliberate yield-chasing.

## Architecture (the batch pattern #2–#7 inherit)

```
GitHub Action (cron */6h + workflow_dispatch)
  → GET https://yields.llama.fi/pools        (17k pools, ~11.8MB)
  → filter + classify + compute (base sort key, divergence)
  → commit pre-filtered JSON (~50–150KB) to repo
static site (Pages/Vercel) reads the committed JSON — instant load, no key, no backend
```
Commit history = portfolio proof of the tool running + free APY-drift history
(so no per-pool `/chart` call needed for durability later).

## Verified data facts (live 2026-09-09)

- `https://yields.llama.fi/pools` → `{status, data:[…]}`, ~11.8MB, **17,217 pools; 3,024 stablecoin.** CORS-open, no key.
- Field availability among **stablecoin** pools:
  `apy` 100% · **`apyBase` 91%** · `apyReward` 45% (null ≈ no rewards) · **`apyMean30d` 100%** · `apyBase7d` 16% (too sparse) · `ilRisk`/`exposure` 100% · `poolMeta` 51% · `outlier` present.
- **272 null-`apyBase`** (188 both-null → apy is organic; 84 reward-present → subtract). Cluster: beefy (99, vaults), velodrome/aerodrome/stargate (LP), curve-llamalend, fraxlend → hence the fallback rule.
- `exposure` among TVL>$1M stable pools: single 741 / multi 225. `ilRisk`: no 958 / yes 8. (`exposure=multi` ≈ LP signal, but the curated map is authoritative.)
- Top stablecoin TVL is **~half permissioned RWA** (BUIDL, USYC, Ondo, Maple, Centrifuge, Invesco, Midas) → hence the access axis. sDAI/Sky is RWA-backed but permissionless → stays in.

## Build checklist

- [ ] `trusted-protocols.json` (~20–30 entries incl. Solana) with `bucket` + `access`
- [ ] `trusted-stables.json` tiered
- [ ] Build script: fetch → filter → classify → compute base sort key + divergence → write JSON
- [ ] GitHub Action YAML (cron */6h + dispatch)
- [ ] Static page: 3 stacked tier windows, bucket column, absolute base|reward bar, re-sort control
- [ ] README framing the opinion (the portfolio narrative)
