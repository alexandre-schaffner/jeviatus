import { describe, expect, test } from "bun:test";
import type { Player } from "src/core/game/Game";
import type { TileRef } from "src/core/game/GameMap";
import { Agent } from "../harness/agent";
import type { Decision } from "../harness/decide/pipeline";
import { TokenBucket } from "../harness/net/rateLimit";
import { checkBuild } from "../extension/src/compat";
import { jevFailureStatus } from "../extension/src/jevErrors";
import { DEFAULT_SETTINGS, isAllowedHost, normalizeSettings } from "../extension/src/settings";

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

  test("permits loopback and openfront.io hosts only", () => {
    expect(isAllowedHost("localhost")).toBe(true);
    expect(isAllowedHost("127.0.0.1")).toBe(true);
    expect(isAllowedHost("openfront.io")).toBe(true);
    expect(isAllowedHost("www.openfront.io")).toBe(true);
    expect(isAllowedHost("[::1]")).toBe(false);
    expect(isAllowedHost("openfront.io.example.com")).toBe(false);
    expect(isAllowedHost("notopenfront.io")).toBe(false);
    expect(isAllowedHost("localhost.example.com")).toBe(false);
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
    config: {
      typesafeApiKey: undefined,
      model: "test",
      openfrontUrl: "http://localhost:9000",
      decisionInterval: 15,
      minConfidence: 0.35,
      goalSwitchProbability: 0.6,
      maxIntentsPerStep: 2,
      intentsPerMinute: 140,
      runsDir: "",
    },
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
    expect(checkBuild(a, a, "openfront.io")).toEqual({ kind: "match", commit: a });
    expect(checkBuild(b, a, "openfront.io")).toEqual({ kind: "mismatch", page: b, bundled: a });
  });

  test("a dev server has nothing to compare against", () => {
    expect(checkBuild("DEV", a, "localhost")).toEqual({ kind: "dev" });
    expect(checkBuild(undefined, a, "127.0.0.1")).toEqual({ kind: "dev" });
  });

  test("a hosted page without a commit is flagged, not silently passed", () => {
    expect(checkBuild(undefined, a, "openfront.io")).toEqual({ kind: "unknown", page: undefined });
    expect(checkBuild("v0.34.18", a, "openfront.io")).toEqual({ kind: "unknown", page: "v0.34.18" });
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
