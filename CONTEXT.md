# DeFi Yield Scanner

A trust filter for stablecoin yield: it answers "where can I park stables right now, and is that yield real?" from DefiLlama data plus a hand-kept opinion.

## Language

### Pools and what they hold

**Pool**:
One place to deposit stablecoins and earn yield, as one row in the rankings. Most come from the DefiLlama feed; some are added by a **Venue correction** (Kamino Lending Vaults).
_Avoid_: market, opportunity, position

**Pool identity**:
What a **Pool** really is, set once during **Pool intake**: its **Legs**, its **Label** and its **Exact URL**.
_Avoid_: metadata, display info

**Leg**:
One stablecoin a **Pool** actually holds (`USDC`), never a vault's share token (`STEAKUSDC`). A pool has one or more legs. Legs alone decide the **Tier**.
_Avoid_: token, asset, symbol

**Label**:
The name a person would recognise on the venue's own app: a vault name ("Steakhouse USDC"), or symbol · market ("USDC · Core").
_Avoid_: display name, symbol

**Exact URL**:
A venue-verified deposit link straight to the pool. When a pool has none, the deposit link falls back to the protocol's site, then DefiLlama.

**Link guard**:
The check on an **Exact URL** that came from a name match (today: Morpho). If the matched vault's TVL is more than 2× away from DefiLlama's, the pool gets no exact URL and links to its DefiLlama page instead, never the protocol's site.
_Avoid_: validation, sanity check

### The opinion

**Tier**:
The coin's class (1 blue-chip · 2 crypto-backed · 3 synthetic), taken from the pool's riskiest **Leg** via `trusted-stables.json`. It is the Coin **Factor**: a ceiling, so a pool's **Level** is never better than its Tier.
_Avoid_: risk band, grade

**Level**:
The pool's risk level (1 lower · 2 medium · 3 higher risk): the worst of its **Factor** levels (weakest link). Pure; computed in `build/risk.mjs`. Behind the `levelWindows` switch the three windows are grouped by Level instead of Tier.
_Avoid_: grade, score, rating

**Factor**:
One thing a **Level** is judged on, each rated 1–3 on its own cut lines: Coin (the **Tier**), Size, Age, Yield, Stability, Protocol. A Factor with no data counts as Level 2 and is marked unknown.
_Avoid_: criterion, metric

**Since override**:
A known start date for a pool (by DefiLlama pool id) or a whole protocol, kept in `build/since.json`. It fixes the Age **Factor** where DefiLlama started tracking a pool late (its day count can only undercount). A start date is a fact, so it never expires. Age otherwise comes from the venue's creation date (Kamino) or DefiLlama's day count.
_Avoid_: start-date patch, age hack

**Base rate**:
The market's plain stablecoin lending rate: the average 30-day mean yield of Aave V3 USDC and USDT on Ethereum (main market), from the DefiLlama feed. The Yield **Factor** judges a pool by its 30-day mean as a multiple of it (Level 1 up to 1.5×, Level 2 up to 2.5×), so the cut lines move with the market. Computed in `build/base-rate.mjs`; the build fails if it is missing.
_Avoid_: benchmark, risk-free rate

**Sticky level**:
The **Level** a pool is shown at, which changes slowly on purpose: it moves down after 2 refreshes in a row at a worse level (~12 hours), up only after 7 days in a row at a better level, and at once when its coin **Tier** changes. The state is kept in `build/state/levels-state.json` (not published); moves are not announced on the page. Pure; `build/sticky.mjs`.
_Avoid_: smoothing, hysteresis

**Bucket**:
How the pool earns: `lend`, `LP` or `vault`, set per protocol in `trusted-protocols.json`.

**Denylist**:
Pools hidden even though they look active, named by DefiLlama pool id, `project|chain|SYMBOL`, or Morpho vault address.

### Getting from the feed to rankings

**Pool intake**:
The step that turns the raw feed plus **Venue data** into the pools the pipeline judges. It applies the **Denylist** and every **Venue correction**, sets lending pools' TVL to total deposits (DefiLlama's `/pools` counts them net of loans), and gives each pool its **Pool identity**. Pure; lives in `build/intake.mjs`.
_Avoid_: preprocessing, enrichment

**Venue data**:
What a venue's own API knows that DefiLlama doesn't (Morpho vault registry, Yearn vault names, Kamino on-chain vaults). Fetched in `build/venues.mjs`; always allowed to be empty.

**Venue correction**:
One venue's rule inside **Pool intake** for fixing what DefiLlama gets wrong about it. Today: Morpho (share token → underlying **Leg** + V1 or V2 vault, under the **Link guard**), Yearn (vault **Label**), Kamino (replace isolated borrow markets with Lending Vaults).
_Avoid_: preprocessor, hack, patch

## Flagged ambiguities

- **`symbol`** in `site/data/latest.json` holds the **Label**, not DefiLlama's symbol. Never split it to get **Legs**; use `legs`.

## Example dialogue

> **Dev:** Beefy vaults show up as `mooUSDC`. Do I add `MOOUSDC` to the stable map?
> **Owner:** No, it isn't a stable. It's a vault share. Write a Beefy **Venue correction** so its **Legs** become `["USDC"]` and its **Label** is the vault name.
> **Dev:** And the tier?
> **Owner:** It follows from the **Legs**. Nothing in the pipeline changes. The new correction gets its own test in `intake.test.mjs`.
