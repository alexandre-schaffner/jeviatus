import { describe, expect, test } from "bun:test";
import { Director, framing, gotoExpression, overviewScale, SCENE, type Scene, type SceneEvent, scaleFor } from "../stream/camera";

const view = { w: 1280, h: 636 };
const scene = (events: SceneEvent[], phase: Scene["phase"] = "alive"): Scene => ({
  phase,
  map: { w: 2000, h: 1000 },
  view,
  me: { name: "jeviatus", place: { x: 500, y: 500, r: 40 }, rank: 3, players: 20, landPct: 2 },
  events,
  leader: { name: "Top", place: { x: 1500, y: 400, r: 100 } },
});
const ev = (key: string, weight: number, label = key): SceneEvent => ({ key, kind: "attack_out", label, place: { x: 600, y: 500, r: 30 }, weight });

describe("camera director", () => {
  test("quiet moments film Jev's territory; spawn films the whole map", () => {
    const d = new Director();
    expect(d.next(scene([]), 0)?.caption).toBe("Jev's territory");
    expect(new Director().next(scene([], "spawn"), 0)?.key).toBe("overview");
  });

  test("holds a shot at least minShotMs, then rotates to what it hasn't shown", () => {
    const d = new Director({ minShotMs: 6000, maxShotMs: 16000, revisitMs: 60000 });
    const s = scene([ev("a", 50), ev("b", 45)]);
    expect(d.next(s, 0)?.key).toBe("a");
    expect(d.next(s, 5000)?.key).toBe("a");
    expect(d.next(s, 12000)?.key).toBe("a");
    expect(d.next(s, 17000)?.key).toBe("b");
    // Both events shown within the revisit window: back home for a beat.
    expect(d.next(s, 34000)?.key).toBe("home");
    // Past the window, the most urgent event comes back.
    expect(d.next(s, 61000)?.key).toBe("a");
  });

  test("an urgent event cuts in after the minimum hold", () => {
    const d = new Director({ minShotMs: 6000, preemptBy: 30 });
    expect(d.next(scene([ev("a", 40)]), 0)?.key).toBe("a");
    const urgent = scene([ev("a", 40), { ...ev("nuke", 100), kind: "nuke_in" }]);
    expect(d.next(urgent, 3000)?.key).toBe("a");
    expect(d.next(urgent, 6500)?.key).toBe("nuke");
  });

  test("after Jev is out: the biggest battle, then the leader", () => {
    const d = new Director({ maxShotMs: 10000 });
    const s = scene([{ ...ev("battle:1", 30, "Biggest battle: A vs B"), kind: "battle" }], "dead");
    expect(d.next(s, 0)?.caption).toBe("Biggest battle: A vs B");
    expect(d.next(s, 11000)?.caption).toBe("The leader: Top");
  });

  test("framing fits the place; the overview fits the map", () => {
    expect(scaleFor({ x: 0, y: 0, r: 100 }, view)).toBeCloseTo(636 / 250, 3);
    expect(scaleFor({ x: 0, y: 0, r: 1 }, view)).toBe(7);
    expect(overviewScale({ w: 2000, h: 1000 }, view)).toBeCloseTo(0.604, 2);
    const d = new Director();
    const shot = d.next(scene([], "spawn"), 0)!;
    expect(framing(shot, scene([], "spawn")).scale).toBeCloseTo(overviewScale({ w: 2000, h: 1000 }, view), 5);
  });

  test("page expressions are valid JavaScript", () => {
    for (const e of [SCENE, gotoExpression({ x: 1.4, y: 2.6 }, 2)]) expect(() => new Function(`return ${e}`)).not.toThrow();
    expect(gotoExpression({ x: 1.4, y: 2.6 }, 2)).toContain("{ x: 1, y: 3 }");
  });
});
