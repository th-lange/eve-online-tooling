// EVE security-status banding, shared by every module that colours a system
// by its security (route planner, local intel, wormhole chain, market search,
// pochven, SystemGraph nodes).
//
// EVE rounds the true (raw SDE/ESI) security value to one decimal for display,
// and the *displayed* value decides the band: displayed >= 0.5 is high-sec
// (CONCORD responds). So a system with true sec 0.45–0.4999 displays as 0.5
// and is high-sec in game, and banding the raw value with `>= 0.5` — as
// several call sites used to do — misclassifies those systems as low-sec.

export type SecBand = "hisec" | "lowsec" | "nullsec";

/** Band a *true* (unrounded) security status the way the game does. */
export function secBand(trueSec: number): SecBand {
  // Round-first: displayed sec >= 0.5 ⇔ true sec >= 0.45.
  if (Math.round(trueSec * 10) / 10 >= 0.5) return "hisec";
  // The low/null boundary uses the raw value: anything above exactly 0.0 is
  // low-sec. (Systems with true sec in (0, 0.05) display as 0.1 in game — CCP
  // rounds those *up* — so rounding here would wrongly band them null-sec.)
  if (trueSec > 0.0) return "lowsec";
  return "nullsec";
}

/** Tailwind text colour per band, for className-based call sites. */
export const SEC_TEXT_CLASS: Record<SecBand, string> = {
  hisec: "text-emerald-400",
  lowsec: "text-amber-400",
  nullsec: "text-rose-400",
};

/** Colour per band for inline-style/SVG rendering; the same 400-strength
 *  palette as SEC_TEXT_CLASS, referenced through the palette variables so the
 *  Light theme's remap reaches it (#1265). */
export const SEC_COLOR: Record<SecBand, string> = {
  hisec: "var(--color-emerald-400)",
  lowsec: "var(--color-amber-400)",
  nullsec: "var(--color-rose-400)",
};
