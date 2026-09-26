// The local trace sink the extension posts game traces to.

import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startTraceSink, type TraceSinkServer } from "../harness/log/sink";

let sink: TraceSinkServer | null = null;
afterEach(async () => {
  await sink?.stop();
  sink = null;
});

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jev-sink-"));
}

function post(body: unknown, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(sink!.url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-jev-trace-token": token },
    body: JSON.stringify(body),
    ...init,
  });
}

function lines(dir: string, gameID: string): Record<string, unknown>[] {
  const game = fs.readdirSync(dir).find((d) => d.endsWith(`-extension-${gameID}`));
  if (game === undefined) return [];
  return fs
    .readFileSync(path.join(dir, game, "trace.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

test("a post with the token appends to that game's trace; batches from two games stay apart", async () => {
  const dir = tmpDir();
  sink = startTraceSink({ dir, port: 0, token: "secret" });
  expect((await post({ gameID: "AbC123", events: [{ type: "run" }, { type: "step", tick: 15 }] }, "secret")).status).toBe(204);
  expect((await post({ gameID: "Other1", events: [{ type: "run" }] }, "secret")).status).toBe(204);
  expect((await post({ gameID: "AbC123", events: [{ type: "summary" }] }, "secret")).status).toBe(204);
  await sink.stop();
  sink = null;
  expect(lines(dir, "AbC123").map((e) => e.type)).toEqual(["run", "step", "summary"]);
  expect(lines(dir, "Other1").map((e) => e.type)).toEqual(["run"]);
});

test("a bad token is refused, and so is anything but a well-formed post", async () => {
  const dir = tmpDir();
  sink = startTraceSink({ dir, port: 0, token: "secret" });
  expect((await post({ gameID: "AbC123", events: [] }, "wrong")).status).toBe(403);
  expect((await post({ gameID: "../../etc", events: [] }, "secret")).status).toBe(400);
  expect((await post({ gameID: "AbC123" }, "secret")).status).toBe(400);
  // A web page's CORS preflight gets nothing to go on.
  const preflight = await fetch(sink.url, { method: "OPTIONS" });
  expect(preflight.status).toBe(404);
  expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  expect(fs.readdirSync(dir)).toEqual([]);
});

test("annotate writes into the latest game's trace", async () => {
  const dir = tmpDir();
  sink = startTraceSink({ dir, port: 0, token: "t" });
  expect(sink.latest()).toBeNull();
  expect(sink.annotate("latest", { type: "stream_result" })).toBe(false);
  await post({ gameID: "First1", events: [{ type: "run" }] }, "t");
  await post({ gameID: "Second", events: [{ type: "run" }] }, "t");
  expect(sink.latest()).toBe("Second");
  expect(sink.annotate("latest", { type: "stream_result", result: "JEV WON at 12:00" })).toBe(true);
  expect(sink.annotate("First1", { type: "note" })).toBe(true);
  await sink.stop();
  sink = null;
  expect(lines(dir, "Second").at(-1)).toEqual({ type: "stream_result", result: "JEV WON at 12:00" });
  expect(lines(dir, "First1").at(-1)).toEqual({ type: "note" });
});
