import { describe, expect, it } from "vitest";
import { hungFromTop, keepInside } from "./rect.js";

const screen = { x: 0, y: 25, width: 1440, height: 875 };

describe("keepInside", () => {
  it("leaves a rectangle that already fits where it is", () => {
    expect(keepInside({ x: 100, y: 100, width: 300, height: 200 }, screen, 16)).toEqual({ x: 100, y: 100, width: 300, height: 200 });
  });

  it("pulls a window that grew past the right edge back by just enough", () => {
    // Placed for a 240-wide window at the top right, then the page asked for 360.
    const placedForNarrow = { x: 1440 - 240 - 16, y: 25 + 16, width: 360, height: 40 };
    expect(keepInside(placedForNarrow, screen, 16)).toEqual({ x: 1440 - 360 - 16, y: 41, width: 360, height: 40 });
  });

  it("pulls a window that grew past the bottom back up", () => {
    expect(keepInside({ x: 10, y: 800, width: 300, height: 400 }, screen, 16)).toEqual({ x: 16, y: 25 + 875 - 400 - 16, width: 300, height: 400 });
  });

  it("keeps the left and top edges visible when the window is larger than the area", () => {
    expect(keepInside({ x: 500, y: 500, width: 2000, height: 2000 }, screen, 16)).toEqual({ x: 16, y: 41, width: 2000, height: 2000 });
  });
});

describe("hungFromTop", () => {
  it("centres on the top edge of the area, wherever the area is", () => {
    expect(hungFromTop({ width: 520, height: 672 }, { x: 0, y: 0, width: 1512, height: 982 })).toEqual({ x: 496, y: 0, width: 520, height: 672 });
    expect(hungFromTop({ width: 520, height: 672 }, { x: -1512, y: 200, width: 1512, height: 982 })).toEqual({ x: -1016, y: 200, width: 520, height: 672 });
  });
});
