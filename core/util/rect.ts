export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The same rectangle, moved (never resized) so that it lies inside `area` with `margin` to spare on every side.
 * A rectangle wider or taller than the area ends up flush with the area's left or top edge. Used to keep floating
 * windows on screen after they grow: their top-left corner stays where it was unless that would push them off.
 */
export function keepInside(rect: Rect, area: Rect, margin = 0): Rect {
  const maxX = area.x + area.width - rect.width - margin;
  const maxY = area.y + area.height - rect.height - margin;
  return {
    ...rect,
    x: Math.max(area.x + margin, Math.min(rect.x, maxX)),
    y: Math.max(area.y + margin, Math.min(rect.y, maxY)),
  };
}
