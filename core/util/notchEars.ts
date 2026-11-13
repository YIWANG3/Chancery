/**
 * Where the counts go beside a display's camera housing while the floating window is at rest. The menu bar is
 * shared: the frontmost app's menus come up to the housing from the left and the status icons from the right, and
 * a count drawn over either hides it. So the counts go where there is room, and where there is none they are not
 * shown; they are all there once the window is opened.
 *
 * `kinds` are the counts to show, the most pressing first, two at the most. `room` is the free width on each side
 * of the housing (Infinity when it could not be measured, which is treated as free). An ear is `ear` wide, and
 * `edge` more is needed once on a side for the shape's corner and a little air.
 */
export function placeEars<T>(kinds: T[], room: { left: number; right: number }, ear: number, edge: number): { left: T[]; right: T[] } {
  const fits = (side: number, n: number) => side >= n * ear + edge;
  const [first, second] = kinds;
  if (first === undefined) return { left: [], right: [] };
  if (second === undefined) {
    if (fits(room.left, 1)) return { left: [first], right: [] };
    return { left: [], right: fits(room.right, 1) ? [first] : [] };
  }
  // One on each side, as the housing asks for; failing that both on the side that has the room, read left to right
  // in the same order; failing that the more pressing one alone.
  if (fits(room.left, 1) && fits(room.right, 1)) return { left: [first], right: [second] };
  if (fits(room.left, 2)) return { left: [first, second], right: [] };
  if (fits(room.right, 2)) return { left: [], right: [first, second] };
  if (fits(room.left, 1)) return { left: [first], right: [] };
  return { left: [], right: fits(room.right, 1) ? [first] : [] };
}
