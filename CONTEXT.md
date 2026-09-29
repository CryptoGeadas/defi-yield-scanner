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

### The opinion

**Tier**:
The pool's risk class (1 blue-chip · 2 crypto-backed · 3 synthetic), taken from its riskiest **Leg** via `trusted-stables.json`.
_Avoid_: risk band, grade

**Bucket**:
How the pool earns: `lend`, `LP` or `vault`, set per protocol in `trusted-protocols.json`.

**Denylist**:
Pools hidden even though they look active, named by DefiLlama pool id, `project|chain|SYMBOL`, or Morpho vault address.

### Getting from the feed to rankings

**Pool intake**:
The step that turns the raw feed plus **Venue data** into the pools the pipeline judges. It applies the **Denylist** and every **Venue correction**, and gives each pool its **Pool identity**. Pure; lives in `build/intake.mjs`.
_Avoid_: preprocessing, enrichment

**Venue data**:
What a venue's own API knows that DefiLlama doesn't (Morpho vault registry, Yearn vault names, Kamino on-chain vaults). Fetched in `build/venues.mjs`; always allowed to be empty.

**Venue correction**:
One venue's rule inside **Pool intake** for fixing what DefiLlama gets wrong about it. Today: Morpho (share token → underlying **Leg** + vault), Yearn (vault **Label**), Kamino (replace isolated borrow markets with Lending Vaults).
_Avoid_: preprocessor, hack, patch

## Flagged ambiguities

- **`symbol`** in `site/data/latest.json` holds the **Label**, not DefiLlama's symbol. Never split it to get **Legs**; use `legs`.

## Example dialogue

> **Dev:** Beefy vaults show up as `mooUSDC`. Do I add `MOOUSDC` to the stable map?
> **Bernardo:** No, it isn't a stable. It's a vault share. Write a Beefy **Venue correction** so its **Legs** become `["USDC"]` and its **Label** is the vault name.
> **Dev:** And the tier?
> **Bernardo:** It follows from the **Legs**. Nothing in the pipeline changes. The new correction gets its own test in `intake.test.mjs`.
