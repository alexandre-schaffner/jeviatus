import { describe, expect, test } from "bun:test";
import type { Candidates } from "../harness/decide/candidates";
import { routeQuestions } from "../harness/decide/questions";
import { parseStrategy, STRATEGY_LIMITS } from "../harness/strategy/doctrine";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitHubBallot, pick, rank, type BallotEntry } from "../stream/ballot";
import { bandText, type BandState } from "../stream/band";
import { formatTokens, parseBribe, parseMemo, type ParsedTransaction, prFromAmount, SolanaBribes } from "../stream/bribes";
import { ingestUrl, loadBribeConfig, loadOutputs } from "../stream/config";
import { bandHeight, describeOutputs, ffmpegArgs, redact, screenSize, slaveFailure } from "../stream/encoder";
import { GPU_SHIM, prepareStorage, REVEAL_FFA_CARD, SNAPSHOT, validUsername, VIEWPORT_ORIGIN } from "../stream/openfront";
import example from "../strategies/example.json";

describe("strategy files", () => {
  test("the example validates", () => {
    expect(parseStrategy(example).ok).toBe(true);
  });

  test("rejects unknown fields, links in names, overlong text and bad goals", () => {
    const base = { name: "Rush", doctrine: "Attack the weakest neighbor early." };
    expect(parseStrategy({ ...base, script: "x" })).toMatchObject({ ok: false });
    expect(parseStrategy({ ...base, name: "join discord.gg/abc" })).toMatchObject({ ok: false });
    expect(parseStrategy({ ...base, name: "see https://x" })).toMatchObject({ ok: false });
    expect(parseStrategy({ ...base, doctrine: "a".repeat(STRATEGY_LIMITS.doctrine + 1) })).toMatchObject({ ok: false });
    expect(parseStrategy({ ...base, goal: "win" })).toMatchObject({ ok: false });
    expect(parseStrategy({ ...base, name: "evil\u202eeman" })).toMatchObject({ ok: false });
    expect(parseStrategy([])).toMatchObject({ ok: false });
  });

  test("normalizes whitespace", () => {
    const r = parseStrategy({ name: "  Slow   and steady ", doctrine: "Build.\n\nThen   attack." });
    expect(r).toEqual({ ok: true, strategy: { name: "Slow and steady", doctrine: "Build. Then attack." } });
  });

  test("route and goal questions lean on the doctrine only when there is one", () => {
    const empty = ["nukeOptions", "nukeTargets", "allianceExtensions", "embargoLifts", "attackTargets", "betrayTargets", "sideAttacks", "retreats", "boatTargets", "buildOptions", "savingsGoals", "allyCandidates", "incomingRequests", "donateTargets", "threatSubjects"];
    const cands = { routes: ["expand", "hold"], ...Object.fromEntries(empty.map((k) => [k, []])) } as unknown as Candidates;
    const without = JSON.stringify(routeQuestions(cands, 3, "full"));
    const withDoctrine = JSON.stringify(routeQuestions(cands, 3, "full", undefined, true));
    expect(without).not.toContain("strategy.doctrine");
    expect(withDoctrine.match(/strategy\.doctrine/g)?.length).toBe(2);
  });
});

// A fake GitHub: PR 1 is an approved strategy, 2 is approved but its author
// pushed afterwards, 3 is a code PR, 4 edits two files, 5 is invalid JSON.
function fakeGitHub(): typeof fetch {
  const pulls = [
    { number: 1, title: "Turtle", draft: false, html_url: "u1", user: { login: "ann" }, head: { sha: "a1" } },
    { number: 2, title: "Rush", draft: false, html_url: "u2", user: { login: "bob" }, head: { sha: "b2" } },
    { number: 3, title: "Refactor", draft: false, html_url: "u3", user: { login: "cy" }, head: { sha: "c3" } },
    { number: 4, title: "Two files", draft: false, html_url: "u4", user: { login: "di" }, head: { sha: "d4" } },
    { number: 5, title: "Broken", draft: false, html_url: "u5", user: { login: "ed" }, head: { sha: "e5" } },
  ];
  const files: Record<number, { filename: string; status: string }[]> = {
    1: [{ filename: "strategies/turtle.json", status: "added" }],
    2: [{ filename: "strategies/rush.json", status: "added" }],
    3: [{ filename: "harness/agent.ts", status: "modified" }],
    4: [{ filename: "strategies/a.json", status: "added" }, { filename: "stream/main.ts", status: "modified" }],
    5: [{ filename: "strategies/broken.json", status: "added" }],
  };
  const content: Record<string, string> = {
    "strategies/turtle.json@a1": JSON.stringify({ name: "Turtle", doctrine: "Fortify." }),
    "strategies/rush.json@b2": JSON.stringify({ name: "Rush", doctrine: "Attack." }),
    "strategies/broken.json@e5": "{ nope",
  };
  const reviews: Record<number, unknown[]> = {
    1: [{ state: "APPROVED", commit_id: "a1", author_association: "OWNER" }],
    2: [{ state: "APPROVED", commit_id: "old", author_association: "OWNER" }],
    5: [],
  };
  const reactions: Record<number, unknown[]> = {
    1: [{ user: { login: "v1", type: "User" } }, { user: { login: "v2", type: "User" } }, { user: { login: "bot", type: "Bot" } }],
  };
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const p = url.pathname.replace("/repos/o/r", "");
    const json = (v: unknown) => new Response(JSON.stringify(v));
    let m: RegExpExecArray | null;
    if (p === "/pulls") return json(pulls);
    if ((m = /^\/pulls\/(\d+)\/files$/.exec(p))) return json(files[Number(m[1])]);
    if ((m = /^\/pulls\/(\d+)\/reviews$/.exec(p))) return json(reviews[Number(m[1])] ?? []);
    if ((m = /^\/issues\/(\d+)\/reactions$/.exec(p))) return json(reactions[Number(m[1])] ?? []);
    if ((m = /^\/contents\/(.+)$/.exec(p))) return new Response(content[`${m[1]}@${url.searchParams.get("ref")}`] ?? "", { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("ballot", () => {
  test("only approved, single-file, valid strategy PRs make the ballot; bots don't vote", async () => {
    const ballot = await new GitHubBallot({ repo: "o/r", requireApproval: true, fetch: fakeGitHub() }).refresh();
    expect(ballot.entries.map((e) => [e.number, e.votes, e.strategy.name])).toEqual([[1, 2, "Turtle"]]);
    const reasons = Object.fromEntries(ballot.rejected.map((r) => [r.number, r.reason]));
    expect(reasons[2]).toContain("approval");
    expect(reasons[4]).toContain("exactly one file");
    expect(reasons[5]).toContain("not valid JSON");
    expect(reasons[3]).toBeUndefined();
  });

  test("without the approval requirement, the pushed-after-approval PR is on it", async () => {
    const ballot = await new GitHubBallot({ repo: "o/r", requireApproval: false, fetch: fakeGitHub() }).refresh();
    expect(ballot.entries.map((e) => e.number)).toEqual([1, 2]);
  });

  test("ranking: most votes, then oldest; below the minimum plays Jev's own judgment", () => {
    const e = (number: number, votes: number) => ({ number, votes, strategy: { name: `S${number}`, doctrine: "d" } }) as BallotEntry;
    expect(rank([e(5, 1), e(3, 4), e(2, 4)]).map((x) => x.number)).toEqual([2, 3, 5]);
    expect(pick({ entries: [e(2, 0)], rejected: [], fetchedAt: 0 }, 1)).toBeNull();
    expect(pick({ entries: [e(2, 1)], rejected: [], fetchedAt: 0 }, 1)?.number).toBe(2);
    expect(pick(null, 0)).toBeNull();
  });
});

describe("broadcast", () => {
  const kick = { name: "kick" as const, url: "rtmps://ingest.example:443/app/sk_live_secret" };
  const cfg = { outputs: [kick], width: 1280, height: 720, fps: 30, videoKbps: 4500, audio: false, display: ":99" };
  const band = { height: bandHeight(720), files: { headline: "/tmp/b/headline.txt", playing: "/tmp/b/playing.txt", status: "/tmp/b/status.txt" } };

  test("ffmpeg: 2 s GOP, CBR-ish, FLV to the ingest, the band padded under the browser", () => {
    const args = ffmpegArgs(cfg, band);
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at("-g")).toBe("60");
    expect(at("-keyint_min")).toBe("60");
    expect(at("-b:v")).toBe("4500k");
    expect(at("-f")).toBe("x11grab");
    expect(at("-video_size")).toBe(`1280x${720 - bandHeight(720)}`);
    expect(args.at(-1)).toBe(kick.url);
    expect(args.at(-2)).toBe("flv");
    expect(at("-filter_complex")).toContain("pad=1280:720:0:0");
    expect(at("-filter_complex")).toContain("textfile='/tmp/b/status.txt':reload=1:expansion=none");
    expect(screenSize(cfg).height + bandHeight(720)).toBe(720);
  });

  test("a file output is a dry run in Matroska; the key never reaches logs", () => {
    const args = ffmpegArgs({ ...cfg, outputs: [{ name: "file", url: "/out/test.mkv" }], audio: true }, band);
    expect(args.slice(-3)).toEqual(["matroska", "-y", "/out/test.mkv"]);
    expect(args).toContain("pulse");
    expect(redact(kick.url)).toBe("rtmps://ingest.example:443/app/<stream key>");
    expect(ingestUrl("rtmps://x.live-video.net:443/app/", "sk_1")).toBe("rtmps://x.live-video.net:443/app/sk_1");
    // A bare Kick (IVS) host, as sometimes copied from the dashboard, gets :443/app.
    expect(ingestUrl("rtmps://x.global-contribute.live-video.net/", "sk_1")).toBe("rtmps://x.global-contribute.live-video.net:443/app/sk_1");
    expect(ingestUrl("rtmps://other.example/live", "k")).toBe("rtmps://other.example/live/k");
  });

  test("band text names the repo, the strategy in play and the ballot", () => {
    const entry = { number: 7, title: "t", author: "ann", url: "u", votes: 12, strategy: { name: "Turtle", doctrine: "d" } };
    const t = bandText({ repo: "o/r", playing: entry, playingPot: null, ballot: { entries: [entry], rejected: [], fetchedAt: 0 }, bribe: null, status: "LIVE", games: 3, lastResult: "eliminated at 9:12" });
    expect(t["headline.txt"]).toContain("github.com/o/r/pulls");
    expect(t["playing.txt"]).toContain('"Turtle"  (PR #7 by @ann, 12 votes)');
    expect(t["playing.txt"]).toContain("#7 Turtle (12)");
    expect(t["status.txt"]).toBe("LIVE  |  games streamed: 3, last: eliminated at 9:12");
    expect(t["bribe.txt"]).toBeUndefined();
    expect(bandText({ repo: "o/r", playing: null, playingPot: null, ballot: null, bribe: null, status: "", games: 0, lastResult: null })["playing.txt"]).toContain("own judgment");
  });

  test("page expressions are valid JavaScript", () => {
    for (const expr of [SNAPSHOT, REVEAL_FFA_CARD, VIEWPORT_ORIGIN, GPU_SHIM, prepareStorage("Jev AI bot", true)]) {
      expect(() => new Function(`return ${expr}`)).not.toThrow();
    }
  });

  test("usernames follow OpenFront's rules", () => {
    expect(validUsername("jeviatus")).toBe(true);
    expect(validUsername("Jev AI bot")).toBe(true);
    expect(validUsername("[AI] Jev")).toBe(false);
    expect(validUsername("J")).toBe(false);
  });
});

describe("platforms", () => {
  const withEnv = <T>(env: Record<string, string | undefined>, f: () => T): T => {
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
    try {
      return f();
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const none = { STREAM_OUTPUT: undefined, KICK_STREAM_URL: undefined, KICK_STREAM_KEY: undefined, PUMPFUN_STREAM_URL: undefined, PUMPFUN_STREAM_KEY: undefined };

  test("Kick and pump.fun together, either alone, or a file instead of both", () => {
    const both = withEnv({ ...none, KICK_STREAM_URL: "rtmps://k/app/", KICK_STREAM_KEY: "sk", PUMPFUN_STREAM_URL: "rtmps://p.rtmp.livekit.cloud/x", PUMPFUN_STREAM_KEY: "pk" }, loadOutputs);
    expect(both).toEqual([{ name: "kick", url: "rtmps://k/app/sk" }, { name: "pumpfun", url: "rtmps://p.rtmp.livekit.cloud/x/pk" }]);
    expect(describeOutputs(both)).toBe("kick (rtmps://k/app/<stream key>), pumpfun (rtmps://p.rtmp.livekit.cloud/x/<stream key>)");
    expect(withEnv({ ...none, PUMPFUN_STREAM_URL: "rtmps://p/x", PUMPFUN_STREAM_KEY: "pk" }, loadOutputs).map((o) => o.name)).toEqual(["pumpfun"]);
    expect(withEnv({ ...none, STREAM_OUTPUT: "/data/x.mkv", KICK_STREAM_URL: "rtmps://k/app/", KICK_STREAM_KEY: "sk" }, loadOutputs)).toEqual([{ name: "file", url: "/data/x.mkv" }]);
    expect(() => withEnv({ ...none, PUMPFUN_STREAM_URL: "rtmps://p/x" }, loadOutputs)).toThrow("PUMPFUN_STREAM_KEY");
    expect(() => withEnv(none, loadOutputs)).toThrow("PUMPFUN_STREAM_URL");
  });

  test("one encode to every platform; only the first one can take the encoder down", () => {
    const outputs = [
      { name: "kick" as const, url: "rtmps://k/app/sk" },
      { name: "pumpfun" as const, url: "rtmps://p/x/pk" },
    ];
    const cfg = { outputs, width: 1280, height: 720, fps: 30, videoKbps: 4500, audio: false, display: ":99" };
    const band = { height: bandHeight(720, 4), files: { headline: "/b/h", playing: "/b/p", bribe: "/b/b", status: "/b/s" } };
    const args = ffmpegArgs(cfg, band, { dir: "/rec", segmentSeconds: 300 });
    expect(args.at(-1)).toBe(
      "[f=flv:onfail=abort]rtmps://k/app/sk|[f=flv:onfail=ignore]rtmps://p/x/pk|[f=segment:segment_time=300:segment_format=matroska:strftime=1:reset_timestamps=1:onfail=ignore]/rec/%Y%m%dT%H%M%SZ.mkv",
    );
    expect(ffmpegArgs(cfg, band).at(-1)).toBe("[f=flv:onfail=abort]rtmps://k/app/sk|[f=flv:onfail=ignore]rtmps://p/x/pk");
    expect(slaveFailure("[tee @ 0x1] Slave muxer #1 failed: Broken pipe, continuing with 2/3 slaves.", outputs)?.name).toBe("pumpfun");
    expect(slaveFailure("[tee @ 0x1] Slave muxer #2 failed: No space left on device, continuing with 2/3 slaves.", outputs)).toBeNull();
    expect(slaveFailure("frame= 100", outputs)).toBeNull();
  });

  test("the bribe line makes the band a line taller", () => {
    expect(bandHeight(720, 4)).toBe(108);
    expect(bandHeight(720)).toBe(84);
    expect(screenSize({ width: 1280, height: 720 }, 4).height).toBe(612);
    const filter = (lines: 3 | 4) => {
      const files = { headline: "/b/h", playing: "/b/p", status: "/b/s", ...(lines === 4 ? { bribe: "/b/b" } : {}) };
      const args = ffmpegArgs({ outputs: [{ name: "file", url: "/x.mkv" }], width: 1280, height: 720, fps: 30, videoKbps: 4500, audio: false, display: ":99" }, { height: bandHeight(720, lines), files });
      return args[args.indexOf("-filter_complex") + 1]!;
    };
    expect(filter(3)).not.toContain("/b/b");
    expect(filter(4)).toContain("textfile='/b/b'");
    expect(filter(4)).toContain("drawbox=x=0:y=612");
  });
});

// A fake Solana: one token account of the stream's wallet, and the
// transactions that touched it.
const MINT = "JEVmint1111111111111111111111111111111pump";
const WALLET = "Wa11et11111111111111111111111111111111111111";
const ATA = "Ata1111111111111111111111111111111111111111";

function transfer(o: { from: string; amount: bigint; memo?: string; to?: string; err?: unknown }): ParsedTransaction {
  const to = o.to ?? WALLET;
  const bal = (owner: string, amount: bigint) => ({ mint: MINT, owner, uiTokenAmount: { amount: String(amount), decimals: 6 } });
  return {
    blockTime: 0,
    meta: {
      err: o.err ?? null,
      preTokenBalances: [bal(o.from, 10n ** 15n), bal(to, 5n)],
      postTokenBalances: [bal(o.from, 10n ** 15n - o.amount), bal(to, 5n + o.amount)],
    },
    transaction: {
      message: { accountKeys: [{ pubkey: "FeePayer" }], instructions: o.memo === undefined ? [] : [{ program: "spl-memo", parsed: o.memo }] },
    },
  };
}

function fakeSolana(chain: { sigs: { signature: string; blockTime: number; err?: unknown }[]; txs: Record<string, ParsedTransaction | null> }): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    if (method === "getTokenSupply") return reply({ value: { decimals: 6 } });
    if (method === "getTokenAccountsByOwner") return reply({ value: [{ pubkey: ATA }] });
    if (method === "getSignaturesForAddress") {
      const { until, before } = params[1] as { until?: string; before?: string };
      let sigs = chain.sigs.map((s) => ({ err: null, ...s })); // newest first
      if (before) sigs = sigs.slice(sigs.findIndex((s) => s.signature === before) + 1);
      if (until) sigs = sigs.slice(0, sigs.findIndex((s) => s.signature === until));
      return reply(sigs);
    }
    if (method === "getTransaction") return reply(chain.txs[params[0] as string] ?? null);
    return new Response("{}", { status: 400 });
  }) as typeof fetch;
}

describe("bribes", () => {
  test("a memo, or failing that the amount's last decimals, names the PR", () => {
    expect(["#12", "12", " PR 12 ", "pr#12"].map(parseMemo)).toEqual([12, 12, 12, 12]);
    expect(["gm", "#0", "12 and 13", ""].map(parseMemo)).toEqual([null, null, null, null]);
    expect(prFromAmount(5_000_000_012n, 6)).toBe(12);
    expect(prFromAmount(5_000_000_000n, 6)).toBeNull();
    expect(prFromAmount(12n, 0)).toBeNull();
  });

  test("reads who sent how much of the coin to the wallet, and for which PR", () => {
    const o = { mint: MINT, wallet: WALLET };
    expect(parseBribe("s", transfer({ from: "Ann", amount: 50_000_000_000n, memo: "#7" }), o)).toEqual({
      signature: "s", from: "Ann", amount: 50_000_000_000n, memo: "#7", pr: 7, blockTime: 0,
    });
    expect(parseBribe("s", transfer({ from: "Bob", amount: 1_000_000_009n, memo: "gm" }), o)?.pr).toBe(9);
    expect(parseBribe("s", transfer({ from: "Cy", amount: 1_000_000_000n }), o)?.pr).toBeNull();
    // Money going out, to someone else, or a failed transaction isn't a bribe.
    expect(parseBribe("s", transfer({ from: WALLET, to: "Ann", amount: 1n }), o)).toBeNull();
    expect(parseBribe("s", transfer({ from: "Ann", to: "Dee", amount: 1n }), o)).toBeNull();
    expect(parseBribe("s", transfer({ from: "Ann", amount: 1n, err: { InstructionError: [0, "x"] } }), o)).toBeNull();
    expect(formatTokens(50_234_500_000n, 6)).toBe("50.2K");
    expect(formatTokens(1_500_000n, 6)).toBe("1.5");
    expect(formatTokens(2_000_000_000_000_000n, 6)).toBe("2B");
  });

  test("counts each bribe once, across refreshes and restarts; a match spends its pot", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jev-bribes-"));
    const ledgerFile = path.join(dir, "bribes.json");
    const since = 1_000_000;
    const chain = {
      sigs: [
        { signature: "s3", blockTime: since + 20 },
        { signature: "s2", blockTime: since + 10 },
        { signature: "sFail", blockTime: since + 5, err: { InstructionError: [0, "x"] } },
        { signature: "s0", blockTime: since - 100 }, // before the stream started counting
      ],
      txs: {
        s3: transfer({ from: "Bob", amount: 2_000_000_009n }),
        s2: transfer({ from: "Ann", amount: 5_000_000_000n, memo: "#7" }),
        s0: transfer({ from: "Old", amount: 9_000_000_000n, memo: "#7" }),
      } as Record<string, ParsedTransaction | null>,
    };
    const open = () => new SolanaBribes({ rpcUrl: "http://rpc", mint: MINT, wallet: WALLET, ticker: "JEV", minTokens: 1, ledgerFile, fetch: fakeSolana(chain), now: () => since * 1000 });
    const bribes = open();
    expect((await bribes.refresh()).map((b) => [b.from, b.pr])).toEqual([["Ann", 7], ["Bob", 9]]);
    expect([...bribes.pots()]).toEqual([[7, 5_000_000_000n], [9, 2_000_000_009n]]);
    expect(bribes.minPot).toBe(1_000_000n);
    expect(bribes.format(5_000_000_000n)).toBe("5K $JEV");

    // A new bribe for #7; the transaction isn't served yet, so it waits.
    chain.sigs.unshift({ signature: "s4", blockTime: since + 30 });
    chain.txs.s4 = null;
    expect(await bribes.refresh()).toEqual([]);
    chain.txs.s4 = transfer({ from: "Cy", amount: 1_000_000_000n, memo: "7" });

    // A restart picks up where the ledger left off.
    const again = open();
    expect((await again.refresh()).map((b) => b.signature)).toEqual(["s4"]);
    expect(again.pots().get(7)).toBe(6_000_000_000n);
    expect(await again.refresh()).toEqual([]);

    expect(again.spend(7)).toBe(6_000_000_000n);
    expect([...open().pots()]).toEqual([[9, 2_000_000_009n]]);
    expect(JSON.parse(readFileSync(ledgerFile, "utf8"))).toMatchObject({ mint: MINT, wallet: WALLET, since });
  });

  test("a big enough pot outranks any vote count, and plays even without votes", () => {
    const e = (number: number, votes: number) => ({ number, votes, strategy: { name: `S${number}`, doctrine: "d" } }) as BallotEntry;
    const ballot = { entries: [e(1, 50), e(2, 0), e(3, 3)], rejected: [], fetchedAt: 0 };
    const pots = new Map([[2, 10n], [3, 500n]]);
    expect(rank(ballot.entries, pots, 1n).map((x) => x.number)).toEqual([3, 2, 1]);
    expect(rank(ballot.entries, pots, 100n).map((x) => x.number)).toEqual([3, 1, 2]);
    expect(pick(ballot, 1, pots, 1000n)?.number).toBe(1);
    expect(pick({ ...ballot, entries: [e(2, 0)] }, 5, pots, 1n)?.number).toBe(2);
    expect(pick({ ...ballot, entries: [e(2, 0)] }, 5)).toBeNull();
  });

  test("the band says how to bribe, who paid for this match, and thanks new bribes", () => {
    const entry = (number: number, votes: number, name: string) => ({ number, title: "t", author: "ann", url: "u", votes, strategy: { name, doctrine: "d" } });
    const turtle = entry(7, 2, "Turtle");
    const rush = entry(9, 40, "Rush");
    const state: BandState = {
      repo: "o/r",
      playing: turtle,
      playingPot: 50_000_000_000n,
      ballot: { entries: [rush, turtle], rejected: [], fetchedAt: 0 },
      bribe: { wallet: WALLET, ticker: "JEV", decimals: 6, pots: new Map([[7, 1_200_000_000n]]), minPot: 1_000_000n, thanks: null },
      status: "LIVE",
      games: 0,
      lastResult: null,
    };
    const t = bandText(state);
    expect(t["playing.txt"]).toContain('"Turtle"  (PR #7 by @ann, bribed 50K $JEV)');
    expect(t["playing.txt"]).toContain("BALLOT  #7 Turtle (2, 1.2K $JEV)  ·  #9 Rush (40)");
    expect(t["bribe.txt"]).toContain(`send $JEV to ${WALLET}`);
    expect(t["bribe.txt"]).toContain("memo #12 or amount ending .000012 backs PR #12");
    expect(bandText({ ...state, bribe: { ...state.bribe!, thanks: "NEW BRIBE" } })["bribe.txt"]).toBe("NEW BRIBE");
  });

  test("bribes need both a coin and a wallet, as Solana addresses", () => {
    const load = (env: Record<string, string | undefined>) => {
      const saved = { BRIBE_MINT: process.env.BRIBE_MINT, BRIBE_WALLET: process.env.BRIBE_WALLET };
      for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      try {
        return loadBribeConfig();
      } finally {
        for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      }
    };
    expect(load({ BRIBE_MINT: undefined, BRIBE_WALLET: undefined })).toBeNull();
    expect(load({ BRIBE_MINT: MINT, BRIBE_WALLET: WALLET })).toMatchObject({ mint: MINT, wallet: WALLET, ticker: "JEV", minTokens: 1 });
    expect(() => load({ BRIBE_MINT: MINT, BRIBE_WALLET: undefined })).toThrow("BRIBE_WALLET");
    expect(() => load({ BRIBE_MINT: "not-an-address!", BRIBE_WALLET: WALLET })).toThrow("BRIBE_MINT");
  });
});
