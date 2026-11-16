// ─────────────────────────────────────────────────────────────────────────────
// VAULT EVENTS — the Scanner's reading of the SQD Portal. Reads vaults' ERC-4626 Deposit and
// Withdraw events and returns them as plain in/out amounts per UTC day. Talking to the
// Portal (retry, deadline, batches, partial progress) is the shared flows core
// (flows-core.mjs, #61); this file says only which logs to ask for and how to read them.
// One query for all vaults of a chain (cost follows the number of events, not vaults).
//
//   fetchVaultFlows({ dataset, vaults: [{ address, decimals }], fromBlock, toBlock, fetchImpl?, sleep?, maxRetries? = 30, onBatch?({ lastBlock, events, bytes }), deadline? })
//     → { events: [{ vault, day: "YYYY-MM-DD", kind: "in" | "out", amount }], lastBlock, lastTimestamp, bytes }
//     Malformed log data is an error, not the end of the data.
//   finalizedHead(dataset) → block number;  blockAt(dataset, unixSeconds) → block number
// ─────────────────────────────────────────────────────────────────────────────

import { streamLogs, PortalError } from "./flows-core.mjs";
export { finalizedHead, blockAt, PortalError } from "./flows-core.mjs";

export const DEPOSIT = "0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7"; // Deposit(address,address,uint256,uint256)
export const WITHDRAW = "0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db"; // Withdraw(address,address,address,uint256,uint256)

export async function fetchVaultFlows({ dataset, vaults, ...rest }) {
  const decimals = new Map(vaults.map((v) => [v.address.toLowerCase(), v.decimals]));
  const decode = (l, block) => {
    const vault = String(l.address).toLowerCase(), t0 = l.topics?.[0];
    if (!decimals.has(vault) || (t0 !== DEPOSIT && t0 !== WITHDRAW)) return null;
    const data = String(l.data);
    if (!/^0x[0-9a-fA-F]{64}/.test(data)) throw new PortalError(200, "bad_log", `block ${block.number} vault ${vault}: data ${data.slice(0, 20)}…`);
    const assets = BigInt(data.slice(0, 66)); // first data word = assets
    return { vault, day: block.day, kind: t0 === DEPOSIT ? "in" : "out", amount: Number(assets) / 10 ** decimals.get(vault) };
  };
  return streamLogs({ dataset, logs: [{ address: [...decimals.keys()], topic0: [DEPOSIT, WITHDRAW] }], decode, ...rest });
}
