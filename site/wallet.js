// Browser-wallet helpers for the deposit panel (#42). No wallet library: wallets speak
// the standard EIP-1193 interface (provider.request) and announce themselves through
// EIP-6963, so the user can pick one when several are installed. Reads (balance,
// allowance, receipts) go to a public RPC for the vault's chain, so they work whatever
// chain the wallet is on; only signing goes through the wallet.

const CHAINS = {
  1: { rpc: "https://ethereum-rpc.publicnode.com", explorer: "https://etherscan.io" },
  8453: { rpc: "https://mainnet.base.org", explorer: "https://basescan.org" },
  42161: { rpc: "https://arb1.arbitrum.io/rpc", explorer: "https://arbiscan.io" },
  10: { rpc: "https://mainnet.optimism.io", explorer: "https://optimistic.etherscan.io" },
  137: { rpc: "https://polygon-bor-rpc.publicnode.com", explorer: "https://polygonscan.com" }, // polygon-rpc.com answers 401 (2026-10-23)
};
const IS_ADDR = /^0x[0-9a-f]{40}$/i;
const IS_HASH = /^0x[0-9a-f]{64}$/i;

// Installed wallets: [{ info: { uuid, name, icon, rdns }, provider }], once each, in the
// order they announced. Wallets answer a request event right away; waitMs gives slow ones
// a moment. With no announcement, an injected window.ethereum counts as one wallet.
export async function discoverWallets({ target = globalThis, waitMs = 300 } = {}) {
  const found = new Map();
  const onAnnounce = (e) => {
    const w = e.detail;
    if (w?.provider && typeof w.info?.name === "string" && w.info.name && w.info.uuid && !found.has(w.info.uuid)) found.set(w.info.uuid, w);
  };
  target.addEventListener("eip6963:announceProvider", onAnnounce);
  target.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((r) => setTimeout(r, waitMs));
  target.removeEventListener("eip6963:announceProvider", onAnnounce);
  if (!found.size && target.ethereum)
    found.set("injected", { info: { uuid: "injected", name: target.ethereum.isMetaMask ? "MetaMask" : "Browser wallet", icon: null, rdns: null }, provider: target.ethereum });
  return [...found.values()];
}

// A wallet's icon goes into the page, so only an image data URI with no quotes or spaces.
export const safeIcon = (icon) => (typeof icon === "string" && /^data:image\/(png|svg\+xml|webp|jpeg|gif);base64,[A-Za-z0-9+/=]+$/.test(icon) ? icon : null);

const word = (a) => {
  if (!IS_ADDR.test(String(a))) throw new Error(`not an address: ${a}`);
  return a.toLowerCase().slice(2).padStart(64, "0");
};
export const callBalanceOf = (owner) => "0x70a08231" + word(owner);
export const callAllowance = (owner, spender) => "0xdd62ed3e" + word(owner) + word(spender);
const MAX_UINT = 2n ** 256n - 1n;
export function callApprove(spender, amount) {
  const n = BigInt(amount);
  if (n <= 0n || n > MAX_UINT) throw new Error(`approval amount out of range: ${n}`);
  return "0x095ea7b3" + word(spender) + n.toString(16).padStart(64, "0");
}
export const needsApproval = (allowanceHex, amount) => BigInt(allowanceHex && allowanceHex !== "0x" ? allowanceHex : "0x0") < BigInt(amount);

// Wallets answer eth_chainId as hex ("0x2105"), some in upper case or as a number.
export function sameChain(answer, chainId) {
  const n = typeof answer === "number" ? answer : /^0x[0-9a-f]+$/i.test(String(answer)) ? parseInt(answer, 16) : /^\d+$/.test(String(answer)) ? Number(answer) : NaN;
  return n === Number(chainId);
}

// LI.FI's own contract (its "Diamond") on the chains the Scanner covers. The deposit goes
// to it and only it may be approved: a quote naming any other contract is refused.
// Same address on all five today (LI.FI docs: "on most supported networks"; checked in
// live quotes on Ethereum, Base and Arbitrum, 2026-10-23).
export const LIFI_DIAMOND = Object.fromEntries([1, 8453, 42161, 10, 137].map((id) => [id, "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae"]));
// Tokens that revert an approval from one non-zero allowance to another (USDT on Ethereum):
// set the allowance to 0 first.
export const RESET_APPROVAL = new Set(["1|0xdac17f958d2ee523a2206206994597c13d831ec7"]);
export const mustResetFirst = (chainId, token, allowanceHex) => RESET_APPROVAL.has(`${chainId}|${String(token).toLowerCase()}`) && !needsApproval(allowanceHex, 1n);

// The one place that decides what the wallet is asked to sign. LI.FI's quote must be for
// exactly this deposit: same chain, the pay token, the amount the user typed, the
// connected account as sender, ending in the vault's token. Anything else throws a plain
// message and nothing is signed.
// chainId: where the user pays and signs; toChainId: the vault's chain (the same for a
// same-chain deposit; another one when LI.FI bridges first, #43).
// → { spender | null, tx } with tx ready for eth_sendTransaction (chainId included, so the
// wallet itself refuses to sign on another network).
export function buildDepositTx(raw, { from, chainId, toChainId = chainId, units, payToken, payDecimals = null, vaultToken }) {
  const a = raw?.action, tr = raw?.transactionRequest, same = (x, y) => String(x ?? "").toLowerCase() === String(y ?? "").toLowerCase();
  const refuse = (why) => { throw Object.assign(new Error(`The quote does not match this deposit (${why}), so nothing was signed. Try again.`), { plain: true }); };
  if (!a || !tr) refuse("no transaction in it");
  if (Number(a.fromChainId) !== chainId || Number(a.toChainId) !== toChainId) refuse("another chain");
  if (!same(a.fromToken?.address, payToken)) refuse("another pay token");
  if (payDecimals != null && a.fromToken?.decimals != null && Number(a.fromToken.decimals) !== payDecimals) refuse("another token precision");
  if (String(a.fromAmount) !== String(units)) refuse("another amount");
  if (!same(a.fromAddress, from)) refuse("another sender");
  if (!same(a.toToken?.address, vaultToken)) refuse("another destination token");
  if (!IS_ADDR.test(String(tr.to)) || !/^0x[0-9a-f]*$/i.test(String(tr.data ?? "")) || String(tr.data ?? "").length < 10) refuse("an unreadable transaction");
  if (tr.chainId != null && !sameChain(tr.chainId, chainId)) refuse("another chain");
  const diamond = LIFI_DIAMOND[chainId];
  if (!diamond || !same(tr.to, diamond)) refuse("another contract");
  if (BigInt(tr.value ?? 0) !== 0n)
    throw Object.assign(new Error("This route also needs ETH for the bridge fee, which this panel does not send. Pick another chain to pay from."), { plain: true, needsGas: true });
  const spender = raw.estimate?.approvalAddress ?? null;
  if (spender != null && !same(spender, diamond)) refuse("another approval address");
  const hex = (v) => (v == null ? undefined : typeof v === "string" && v.startsWith("0x") ? v : "0x" + BigInt(v).toString(16));
  return { spender, tx: { from, to: tr.to, data: tr.data, value: hex(tr.value) ?? "0x0", gas: hex(tr.gasLimit), chainId: "0x" + chainId.toString(16) } };
}

// LI.FI's /status answer (cross-chain, #43) → { phase: pending | done | partial | refunded |
// failed | check }. "check": finished in a way this page doesn't know — send the user to
// the transaction rather than claim success.
export function readStatus(j) {
  if (j?.status === "DONE") {
    const p = { COMPLETED: "done", PARTIAL: "partial", REFUNDED: "refunded" }[j.substatus];
    return { phase: p ?? "check" };
  }
  if (j?.status === "FAILED") return { phase: "failed" };
  if (j?.status === "INVALID") return { phase: "check" }; // LI.FI can't read this transfer: send the user to it
  return { phase: "pending", message: typeof j?.substatusMessage === "string" ? j.substatusMessage : null };
}

export const CHAIN_NAME = { 1: "Ethereum", 8453: "Base", 42161: "Arbitrum", 10: "Optimism", 137: "Polygon" };
export const PAY_CHAINS = [1, 8453, 42161, 10, 137]; // the Scanner's EVM chains (deposit-protocols' order is not used)

// The same coin as the vault's underlying token on each pay chain, from LI.FI's token list:
// chainId → { address, symbol, decimals } | null (that coin isn't on that chain). Same coin
// = same coinKey as the vault chain's token, so a look-alike symbol never counts.
// The vault chain's own token is always the row's (never looked up).
// A chain whose lookup failed (HTTP error, network, rate limit) is left OUT of the map, so
// the panel says "couldn't check" and asks again next time; null means LI.FI really has
// no such coin there. Decimals are read from the token contract itself: a wrong value
// would turn "250" into the wrong amount, and the quote would agree with it.
// decimalsOf(chainId, address) → number; injectable for tests.
export async function resolvePayTokens(vaultChainId, underlying, { chainIds = PAY_CHAINS, fetchImpl = fetch, decimalsOf = chainDecimals } = {}) {
  const get = async (chain, token) => {
    const r = await fetchImpl(`https://li.quest/v1/token?chain=${chain}&token=${encodeURIComponent(token)}`);
    if (r.status === 404 || r.status === 400) return null; // not listed
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return IS_ADDR.test(String(j?.address)) && Number.isInteger(j?.decimals) && Number(j.chainId) === Number(chain) ? j : null;
  };
  const out = new Map([[vaultChainId, { address: underlying.address, symbol: underlying.symbol, decimals: underlying.decimals }]]);
  let key;
  try { key = (await get(vaultChainId, underlying.address))?.coinKey ?? null; }
  catch (e) { console.warn("pay tokens: vault token lookup failed", e); return out; } // nothing else can be checked yet
  await Promise.all(chainIds.filter((c) => c !== vaultChainId).map(async (c) => {
    try {
      const t = key ? await get(c, underlying.symbol) : null;
      if (!t || t.coinKey !== key) return out.set(c, null);
      if ((await decimalsOf(c, t.address)) !== t.decimals) { console.warn(`pay tokens: ${t.symbol} on chain ${c}: decimals differ from LI.FI's, not offered`); return out.set(c, null); }
      out.set(c, { address: t.address.toLowerCase(), symbol: t.symbol, decimals: t.decimals });
    } catch (e) { console.warn(`pay tokens: lookup on chain ${c} failed`, e); } // left out: "couldn't check"
  }));
  return out;
}
async function chainDecimals(chainId, token) {
  return Number(BigInt(await readChain(chainId, "eth_call", [{ to: token, data: "0x313ce567" }, "latest"])));
}

export const explorerAddress = (chainId, address) => (CHAINS[chainId] && IS_ADDR.test(String(address)) ? `${CHAINS[chainId].explorer}/address/${address}` : null);

// What wallet_addEthereumChain needs when the wallet doesn't know a chain yet (EIP-3085).
export function addChainParams(chainId) {
  const c = CHAINS[chainId];
  if (!c) return null;
  const native = chainId === 137 ? { name: "POL", symbol: "POL", decimals: 18 } : { name: "Ether", symbol: "ETH", decimals: 18 };
  return { chainId: "0x" + chainId.toString(16), chainName: CHAIN_NAME[chainId], nativeCurrency: native, rpcUrls: [c.rpc], blockExplorerUrls: [c.explorer] };
}

export const explorerTx = (chainId, hash) => (CHAINS[chainId] && IS_HASH.test(String(hash)) ? `${CHAINS[chainId].explorer}/tx/${hash}` : null);
export const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
// EIP-1193 code 4001 = the user said no in the wallet. Some wallets wrap it in an RPC error
// (data.originalError / cause) or send only a message.
export function isRejection(e, depth = 0) {
  if (!e || depth > 3) return false;
  if (e.code === 4001 || e.code === "ACTION_REJECTED" || /user (rejected|denied)/i.test(String(e.message ?? ""))) return true;
  return isRejection(e.data?.originalError ?? e.data, depth + 1) || isRejection(e.cause, depth + 1);
}

// Read-only JSON-RPC to the chain's public node.
export async function readChain(chainId, method, params, { signal } = {}) {
  const c = CHAINS[chainId];
  if (!c) throw new Error(`no RPC for chain ${chainId}`);
  const r = await fetch(c.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal });
  if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "RPC error");
  return j.result;
}

// Waits for a transaction to be mined. → true (success) | false (reverted); throws a
// TimeoutError when it is still not mined after maxMs. A failed read (busy public node)
// is retried and logged once; a chain with no RPC is a setup error and throws at once.
export async function waitForReceipt(chainId, hash, { signal, everyMs = 2000, maxMs = 300_000 } = {}) {
  if (!CHAINS[chainId]) throw new Error(`no RPC for chain ${chainId}`);
  let logged = false;
  for (let t = 0; t < maxMs; t += everyMs) {
    const rc = await readChain(chainId, "eth_getTransactionReceipt", [hash], { signal }).catch((e) => {
      if (signal?.aborted) throw e;
      if (!logged) { logged = true; console.warn(`receipt read for ${hash} failed (retrying)`, e); }
      return null;
    });
    if (rc) return rc.status === "0x1";
    await new Promise((r) => setTimeout(r, everyMs));
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  }
  throw new DOMException("the transaction is still not confirmed", "TimeoutError");
}
