import { describe, expect, it } from "vitest";
import { placeEars } from "./notchEars.js";

const EAR = 42;
const EDGE = 10;
const free = Infinity;

describe("placeEars", () => {
  it("puts one count on each side of the housing when both sides are free", () => {
    expect(placeEars(["needs", "running"], { left: free, right: free }, EAR, EDGE)).toEqual({ left: ["needs"], right: ["running"] });
    expect(placeEars(["look"], { left: free, right: free }, EAR, EDGE)).toEqual({ left: ["look"], right: [] });
    expect(placeEars([], { left: free, right: free }, EAR, EDGE)).toEqual({ left: [], right: [] });
  });

  it("moves both to the side that has room when a status icon or a menu is up against the housing", () => {
    // 20pt between the housing and the first status icon: not enough for an ear.
    expect(placeEars(["needs", "running"], { left: 260, right: 20 }, EAR, EDGE)).toEqual({ left: ["needs", "running"], right: [] });
    expect(placeEars(["needs", "running"], { left: 8, right: 300 }, EAR, EDGE)).toEqual({ left: [], right: ["needs", "running"] });
    expect(placeEars(["look"], { left: 8, right: 300 }, EAR, EDGE)).toEqual({ left: [], right: ["look"] });
  });

  it("shows only the more pressing count when there is room for one, and none when there is room for none", () => {
    expect(placeEars(["needs", "running"], { left: 60, right: 20 }, EAR, EDGE)).toEqual({ left: ["needs"], right: [] });
    expect(placeEars(["needs", "running"], { left: 20, right: 60 }, EAR, EDGE)).toEqual({ left: [], right: ["needs"] });
    expect(placeEars(["needs", "running"], { left: 20, right: 20 }, EAR, EDGE)).toEqual({ left: [], right: [] });
  });
});
