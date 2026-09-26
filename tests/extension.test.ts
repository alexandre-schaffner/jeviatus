import { describe, expect, test } from "bun:test";
import type { Player } from "src/core/game/Game";
import type { TileRef } from "src/core/game/GameMap";
import { Agent } from "../harness/agent";
import type { Decision } from "../harness/decide/pipeline";
import { TokenBucket } from "../harness/net/rateLimit";
import { checkBuild } from "../extension/src/compat";
import { jevFailureStatus } from "../extension/src/jevErrors";
import { DEFAULT_SETTINGS, normalizeSettings } from "../extension/src/settings";

describe("extension settings boundary", () => {
  test("defaults invalid and missing values", () => {
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ model: "  ", decisionInterval: "wat", minConfidence: Infinity })).toEqual(DEFAULT_SETTINGS);
  });

  test("trims and clamps user-controlled values", () => {
    expect(
      normalizeSettings({
        enabled: true,
        apiKey: "  secret  ",
        model: " jev-next ",
        decisionInterval: 2.2,
        minConfidence: 9,
      }),
    ).toEqual({ enabled: true, apiKey: "secret", model: "jev-next", decisionInterval: 5, minConfidence: 1 });
  });
});

test("the action gate blocks a decision completed after Jev is disabled", () => {
  let sends = 0;
  const game = {
    ticks: () => 10,
    inSpawnPhase: () => true,
    isLand: () => true,
    hasOwner: () => false,
  };
  const agent = new Agent({
    name: "test",
    mirror: { game } as never,
    jev: { ask: async () => { throw new Error("not called"); } },
    config: { decisionInterval: 15, minConfidence: 0.35, maxIntentsPerStep: 2 },
    bucket: new TokenBucket(140),
    send: () => sends++,
    canAct: () => false,
  });
  const decision = {
    route: "spawn",
    actions: [{ kind: "spawn", tile: 1 as TileRef }],
    confidence: 1,
    used: {},
    preferences: {},
    held: false,
    calls: [],
  } satisfies Decision;
  const result = (
    agent as unknown as {
      act(me: Player, decision: Decision): { desc: string; sent: boolean; reason?: string }[];
    }
  ).act({} as Player, decision);

  expect(sends).toBe(0);
  expect(result).toEqual([{ desc: "spawn@1", sent: false, reason: "disabled" }]);
});

describe("bundled build check", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);

  test("an exact commit match passes, any other real commit blocks", () => {
    expect(checkBuild(a, a, "openfront.io")).toBe("ok");
    expect(checkBuild(b, a, "openfront.io")).toBe("mismatch");
  });

  test("a dev server has nothing to compare against", () => {
    expect(checkBuild("DEV", a, "localhost")).toBe("ok");
    expect(checkBuild(undefined, a, "127.0.0.1")).toBe("ok");
  });

  test("a hosted page without a commit is flagged, not silently passed", () => {
    expect(checkBuild(undefined, a, "openfront.io")).toBe("unverified");
    expect(checkBuild("v0.34.18", a, "openfront.io")).toBe("unverified");
  });
});

describe("Jev failure messages", () => {
  test("turn fixable failures into instructions", () => {
    expect(jevFailureStatus("Extension context invalidated.")?.title).toBe("Extension reloaded");
    expect(jevFailureStatus("Add a TypeSafe API key in the Jev extension popup")?.title).toBe("Jev can't sign in");
    expect(jevFailureStatus("HTTP 401 Unauthorized")?.title).toBe("Jev can't sign in");
    expect(jevFailureStatus("Request timed out after 4000ms")?.tone).toBe("warn");
    expect(jevFailureStatus("something else")).toBeNull();
  });
});
