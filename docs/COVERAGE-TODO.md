# TODO: Pool coverage must expand — "represent most of what's out there"

**Priority: high. Owner decision (Bernardo, 2026-09): the site currently shows too
few pools to credibly represent the stablecoin-yield landscape. Fix this by whatever
means necessary.**

## The problem

The ranking pipeline only renders a pool if **every leg of its `symbol` is found in
`trusted-stables.json`** (see `build/pipeline.mjs` → `classifyTier`). That silently
drops large, legitimate categories of stablecoin yield whose symbol isn't a bare
stable ticker:

- **Vault-wrapped positions** — a MetaMorpho vault reports `symbol: "STEAKUSDC"`, an
  ERC-4626 vault reports `steakUSDC` / `gtUSDCcore` / `yvUSDC`, etc. These are USDC
  yield, but `STEAKUSDC` isn't in the stable map → dropped. (This is why "Morpho
  Blue" showed only 7 rows when Morpho actually has 40+ stablecoin vaults.)
- **Symbols the map simply doesn't list yet** — every new stable, LST-stable, or
  wrapper we haven't hand-added.
- **Whole protocols not in `trusted-protocols.json`** — the allowlist is deliberately
  curated, but it also caps breadth.

## Directions to fix (by whatever means necessary)

1. **Resolve vault symbols to their underlying asset.** For vault-shaped pools
   (Morpho, Yearn, Beefy, ERC-4626 in general), look up the vault's `asset` via the
   protocol API / on-chain and classify by *that* stable, not the share-token symbol.
   The Morpho work (2026-09) is the first instance of this pattern — generalise it.
2. **Broaden `trusted-stables.json`** aggressively (script it from a stablecoin list),
   keeping the tier judgement.
3. **Reconsider the hard protocol allowlist** — maybe shift from "allowlist to render"
   to "allowlist boosts trust, everything reputable renders with a caveat".
4. **Revisit the $1M TVL floor and chain set** if still too sparse.

## Definition of done

The site shows a breadth of stablecoin pools comparable to a DefiLlama "stablecoin
yields" view (filtered to our trust criteria) — not a hand-picked few dozen.

_Linked from: the ranking pipeline (`build/pipeline.mjs`), and the deep-link work in
`build/deeplinks.mjs` / `build/deeplink-sources.mjs`._
