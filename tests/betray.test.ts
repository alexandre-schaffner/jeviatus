// The betrayal layer: an ally that blocks the win can be broken with and
// attacked, and the attack follows as soon as the break lands.

import { expect, test } from "bun:test";
import { Agent } from "../harness/agent";
import { TokenBucket } from "../harness/net/rateLimit";
import { FakeJev, neighbors, testConfig } from "./helpers";

test("Jev can break an alliance, and the agent attacks the moment the break lands", async () => {
  const { g, me, other } = await neighbors();
  g.sendAs(1, { type: "allianceRequest", recipient: me.id() });
  g.step(2);
  g.send({ type: "allianceRequest", recipient: other.id() });
  g.step(3);
  expect(me.isAlliedWith(other)).toBe(true);
  other.removeTroops(other.troops() * 0.8);

  const jev = new FakeJev();
  jev.prefer = { route: "break_alliance", betray_target: (keys) => keys.find((k) => k !== "none")! };
  jev.score = { attack_commit: 2 };
  const config = testConfig({ decisionInterval: 10 });
  const agent = new Agent({ name: "Jev", mirror: g.mirror, jev, config, bucket: new TokenBucket(140), send: g.send });

  // Run until a decision step has fired and its break has been sent.
  for (let i = 0; i < 20 && me.isAlliedWith(other); i++) {
    g.step(1);
    agent.onTick();
    await agent.pending;
  }
  const route = jev.asked.find((a) => a.label === "route")!;
  expect(Object.keys((route.questions.route as { criteria: object }).criteria)).toContain("break_alliance");
  expect(me.isAlliedWith(other)).toBe(false);
  expect(me.isTraitor()).toBe(true);

  // The queued attack goes out within a few ticks, with no new Jev call.
  const calls = jev.asked.length;
  for (let i = 0; i < 5 && !other.incomingAttacks().some((a) => a.attacker() === me); i++) {
    g.step(1);
    agent.onTick();
  }
  expect(other.incomingAttacks().some((a) => a.attacker() === me)).toBe(true);
  expect(jev.asked.length).toBe(calls);
}, 120_000);
