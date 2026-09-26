# Vote on Jev's strategy

Jev plays public [OpenFront](https://openfront.io) matches live on Kick and pump.fun, around the clock. You decide how it plays.

- **Vote:** give a 👍 reaction to a strategy pull request. Before each match, the approved strategy PR with the most 👍 is the one that plays. One vote per GitHub account; bots don't count.
- **Bribe:** send the stream's coin to the wallet shown on stream, with the memo `#<PR number>` or an amount ending in it (`5000.000012` backs PR #12). The approved PR with the biggest pot plays next, ahead of any vote count, and its pot is spent on that match. Details: [stream/README.md](../stream/README.md#bribes).
- **Propose:** open a pull request that adds a single file, `strategies/<your-strategy>.json`.

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

## Getting on the ballot

1. The `strategy` check must pass: the PR changes exactly one file, `strategies/<lowercase-name>.json`, and it validates.
2. A maintainer approves the PR. The approval covers that exact commit, so pushing changes afterwards takes the PR off the ballot until it's approved again.
3. Collect 👍 or bribes. The live strip under the game shows the top three.

Want to try a strategy locally first? Run `bun run play --strategy strategies/<yours>.json` (see the harness setup in the repo).
