// How a floating window's page is to paint itself. The main process decides (main/index.ts: the style setting, and
// what this machine can do) and says so in the page's address: `#/float?look=notch&nw=185&nh=32`.
//
//   glass  the window stands on Liquid Glass; the page paints a thin veil and no background
//   clear  nothing is behind the page; it paints a dark sheet as thick as the person asked for (`tint`, percent;
//          none at 0) and gives its text a halo, so it reads over anything
//   solid  the page paints the app's panel color, as in any other window
//   notch  nothing is behind the page; it draws a black shape growing out of the display's camera housing
export type Look = "glass" | "clear" | "solid" | "notch";

const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
const LOOKS: Look[] = ["glass", "clear", "solid", "notch"];
const asked = params.get("look") as Look | null;

export const LOOK: Look = asked && LOOKS.includes(asked) ? asked : "solid";
const one = <T extends string>(key: string, among: readonly T[]): T => among.find((v) => v === params.get(key)) ?? among[0]!;
/** For the notch look: the camera housing's size in points, and how the person wants the shape to behave
 *  (main/settings.ts; the first of each is the default). */
export const NOTCH = {
  width: Number(params.get("nw")) || 185,
  height: Number(params.get("nh")) || 32,
  /** False on a display without a housing: the size is then a stand-in's, and nothing has to be kept clear of. */
  real: params.get("real") !== "0",
  rest: one("rest", ["counts", "hidden"] as const),
  corners: one("corners", ["round", "tight"] as const),
  open: one("open", ["hover", "click"] as const),
};

/** Marks <html> with the look, for the stylesheet (and Tailwind's `glass:` variant, which covers both looks that
 *  have no background). Called before anything is painted, so the page never flashes a solid background. */
export function markLook() {
  const classes: Record<Look, string[]> = { glass: ["glass"], clear: ["glass", "clear"], solid: [], notch: ["notch"] };
  document.documentElement.classList.add(...classes[LOOK]);
  // The sheet is the same veil the glass look has (styles.css), black and as thick as asked.
  if (LOOK === "clear") document.documentElement.style.setProperty("--glass-veil", `0 0 0 / ${Math.max(0, Math.min(100, Number(params.get("tint")) || 0)) / 100}`);
}
