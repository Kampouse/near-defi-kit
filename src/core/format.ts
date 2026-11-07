// core/format.ts — display formatting + human-input parsing.
// Money-safety law: these are the ONLY functions allowed to turn human
// input into raw amounts. parseInput returns null on anything ambiguous.

export function fmtRaw(raw: bigint, decimals: number, maxFrac = 6): string {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  let s = fracStr ? `${whole}.${fracStr}` : whole.toString();
  if (neg) s = "-" + s;
  return s;
}

/** human input → raw BigInt; null on garbage. Accepts up to `decimals` fraction digits. */
export function parseInput(s: string, decimals: number): bigint | null {
  const t = s.trim();
  if (!/^\d*(\.\d*)?$/.test(t) || t === "" || t === ".") return null;
  const [w, f = ""] = t.split(".");
  if (f.length > decimals) return null;
  const base = 10n ** BigInt(decimals);
  return BigInt(w || "0") * base + BigInt((f + "0".repeat(decimals)).slice(0, decimals));
}

export function shortAcct(a: string): string {
  return a.length > 20 ? a.slice(0, 8) + "…" + a.slice(-6) : a;
}

/** percent slippage (e.g. 0.5) → min received floor: out × (1 − tol/100) */
export function minReceived(out: bigint, slippagePercent: number): bigint {
  const ppm = BigInt(Math.round(slippagePercent * 10000)); // basis points
  return (out * (10000n - ppm)) / 10000n;
}
