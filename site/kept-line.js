// #70: the scan panel's line under the kept count. Kept pools include the KYC ones, which the
// level strip leaves out until "Show KYC pools" is on, so the line says how many and where they are.
export function keptLine(stats, kycCount, kycShown) {
  const base = `kept of ${Number(stats.totalPools).toLocaleString("en-US")} pools`;
  if (!kycCount) return base;
  return `${base} · ${kycCount} need${kycCount === 1 ? "s" : ""} KYC (${kycShown ? "shown" : "hidden"})`;
}
