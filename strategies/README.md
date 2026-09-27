# Pick Jev's strategy

Jev plays public [OpenFront](https://openfront.io) matches live on Kick and pump.fun, around the clock. You decide how it plays.

- **Propose:** anyone can open a pull request that adds a single file, `strategies/<your-strategy>.json`.
- **Promote:** give a 👍 to the proposals you like (one per GitHub account; bots don't count), or bribe with the stream's pump.fun coin. To bribe, send the coin to the wallet shown on stream with the memo `#<PR number>`, or with an amount ending in it (`5000.000012` promotes PR #12). The band shows the leading proposals, biggest bribes first, then most 👍. Details: [stream/README.md](../stream/README.md#bribes).
- **Ship:** the maintainer reviews and merges. The newest merged strategy is what Jev plays, until the next one is merged. Votes and bribes decide what gets looked at first, not what gets merged.

```json
{
  "name": "Turtle Economy",
  "doctrine": "Grab nearby unclaimed land early, then stop expanding and build cities, ports and factories on rail. Ally with big neighbors and never attack an ally. Only fight a weak neighbor you can finish.",
  "goal": "build_economy"
}
```

| Field | Rules |
| --- | --- |
| `name` | Up to 40 characters. It's shown on stream, so no links. |
| `doctrine` | Up to 400 characters of plain-English guidance. Jev reads it before every decision. |
| `goal` | Optional starting goal: `grow_territory`, `build_economy`, `fortify`, `conquer_neighbor` or `survive`. Jev can change goals later if the match demands it. |

## How your doctrine is used

Jev (TypeSafe's System One model) picks among the moves that are legal right now: expand, attack, send a boat invasion, build, make or break alliances, and so on. Your doctrine goes into the state it reads for every choice, with an instruction to follow its spirit unless doing so clearly risks losing. So describe priorities and style, like *"never start wars; out-build everyone"*. Coordinates or exact build orders won't work, because Jev chooses among the moves code offers.

Strategies are data only: a strategy PR never runs code on the stream.

## From proposal to stream

1. The `strategy` check must pass: the PR changes exactly one file, `strategies/<lowercase-name>.json`, and it validates. It then shows in the review queue on stream.
2. Collect 👍 and bribes to move it up the queue.
3. The maintainer merges it, maybe after asking for changes. From the next match on, it's what Jev plays.

A maintainer can hide a proposal from the stream by labeling it `off-ballot`, so keep names fit for a public stream. There are no refunds for bribes on proposals that are closed or never merged.

Want to try a strategy locally first? Run `bun run play --strategy strategies/<yours>.json` (see the harness setup in the repo).
