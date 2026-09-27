# Running the stream on a server

This moves the 24/7 stream (`stream/`, see [stream/README.md](../stream/README.md)) from the Mac to a rented Linux server. The server runs the same Docker image as `bun run stream:up`, and one script, `deploy/deploy.sh`, drives it from the Mac. The server needs no GitHub access: the code goes over as a git bundle of your current commit, and `.env` goes over SSH.

## The host: Hetzner Cloud CX43

The container needs about 4 vCPU and 8 GB of RAM. Chromium renders WebGL on the CPU (Mesa's llvmpipe), and x264 encodes 720p30 next to it. It also needs about 1.5 TB of upload a month (4.7 Mbit/s, around the clock), and a disk for `/data`.

| | vCPU / RAM | Monthly, excl. VAT | Traffic included | Notes |
| --- | --- | --- | --- | --- |
| **Hetzner CX43** (recommended) | 8 shared / 16 GB, 160 GB NVMe | **€15.99** + IPv4 | 20 TB (EU) | Twice the CPU the stream needs, so neighbors' load doesn't drop frames. Billed hourly. |
| Hetzner CPX42 / CPX32 | 8 / 16 GB, or 4 / 8 GB (shared AMD) | €69.49 / €35.49 | 20 TB (EU) | If CX is sold out where you want it. |
| Hetzner CCX23 | 4 dedicated / 16 GB | €85.99 | 20 TB (EU) | Dedicated cores, for when shared CPUs steal too much time. |
| Fly.io performance-4x | 4 dedicated / 8 GB | roughly $124+, plus $0.02/GB upload (~$30) | none | Shared-CPU machines are throttled under constant load, which rules them out. The compose file would need porting to `fly.toml`. |

Hetzner prices are from its [15 June 2026 price adjustment](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/). Fly's are from [its pricing page](https://fly.io/docs/about/pricing/) and its calculator; check them before you order. Pick an EU location (Nuremberg `nbg1`, Falkenstein `fsn1`, Helsinki `hel1`), because only the EU locations include 20 TB of traffic. In the US, traffic is 1 to 8 TB. You can resize a Hetzner server later from its console (Rescale, "CPU and RAM only" keeps the disk and IP), so starting with a CX43 costs nothing if it turns out too small.

The server itself is the only new infrastructure cost. The stream's other costs don't change: TypeSafe, and the commentator at about $4/day (Claude Haiku). The lab's cost is [covered below](#claude-code-for-the-lab).

## Morning steps

Everything below runs from the Mac, in this repository, on the commit you want to deploy.

1. **Create a Hetzner account:** [accounts.hetzner.com/signUp](https://accounts.hetzner.com/signUp). It asks for identity and payment verification. Create a project, e.g. `jeviatus`.
2. **Add your SSH key** in the project: Security → SSH keys → Add. Your keys live in 1Password's SSH agent, so either copy the public key from 1Password, or print it with:
   ```sh
   SSH_AUTH_SOCK=~/Library/Group\ Containers/2BUA8C4S2C.com.1password/t/agent.sock ssh-add -L
   ```
3. **Create the server:** Servers → Add server. Pick location **Nuremberg** (or Falkenstein / Helsinki), image **Ubuntu 24.04**, type **Cost-Optimized → CX43**, public IPv4 on, and your SSH key. No volume, no backups needed. Note its IP address.
   Or from the CLI: `brew install hcloud`, `hcloud context create jeviatus` (paste an API token from Security → API tokens), then
   ```sh
   hcloud server create --name jeviatus --type cx43 --image ubuntu-24.04 --location nbg1 --ssh-key <key name>
   ```
4. **Log Claude Code in for the lab** (see [below](#claude-code-for-the-lab)): run `claude setup-token`, then put the token in `.env` as `CLAUDE_CODE_OAUTH_TOKEN=…`. Or set `STREAM_LAB=false` to go without the lab.
5. **Commit** what you want live. Only the commit goes over, not uncommitted changes.
6. **Dry run while the Mac is still live** (recommended). It plays real matches but records to a file instead of streaming, so it can't collide with the Mac's stream:
   ```sh
   deploy/deploy.sh root@<ip> dry-run     # first build: 10-15 minutes
   deploy/deploy.sh root@<ip> logs        # watch a match or two; Ctrl-C stops following
   deploy/deploy.sh root@<ip> fetch dry-run.mkv   # then open it: frame rate, band, sound
   ```
   In the logs, check that matches start and that no `Cloudflare` lines show up ([Turnstile](#cloudflare-turnstile)). `deploy/deploy.sh root@<ip> status` shows CPU and memory use.
7. **Switch the stream over.** See [Moving the stream off the Mac](#moving-the-stream-off-the-mac): stop the Mac, then `migrate`, then `up`.

## Moving the stream off the Mac

Kick and pump.fun take one encoder per stream key. Two machines sending with the same key fight over it, and viewers see it flicker or drop. So the Mac stops first:

1. In the terminal running `bun run live`, press **Ctrl-C** and wait for it to exit (up to about 15 s). Kick shows the channel offline. `pgrep -fl stream/main.ts` should print nothing.
2. Copy the Mac's game traces (the lab learns from them), the bribe ledger and your own music to the server:
   ```sh
   deploy/deploy.sh root@<ip> migrate
   ```
3. Go live from the server:
   ```sh
   deploy/deploy.sh root@<ip> up
   ```
   `up` refuses to start while a stream is still running on this Mac (`--force` overrides that, e.g. for a different stream key). It installs Docker the first time, sends the commit and `.env`, builds and starts the container with `restart: unless-stopped`. The container survives reboots and restarts its own crashed processes.
4. Watch it come up: `deploy/deploy.sh root@<ip> logs`. Kick should show the stream within a couple of minutes.

To go back to the Mac: `deploy/deploy.sh root@<ip> down`, then `bun run live` on the Mac. To deploy a new commit, commit it and run `deploy/deploy.sh root@<ip> up` again. It rebuilds and restarts, with a short gap on stream.

Mac-only settings in `.env` (`STREAM_PLATFORM`, `FFMPEG_BIN`, any `/Users/…` or `/opt/homebrew` path) aren't sent to the server. `CHROMIUM_FLAGS` always gets `--no-sandbox`, which the container needs.

## Watching it

| | |
| --- | --- |
| `deploy/deploy.sh <host> logs` | Follow the logs (the last 200 lines first). Docker keeps 5 × 20 MB. |
| `deploy/deploy.sh <host> status` | Container state, health, CPU and memory. Health means Chromium answers on DevTools and the encoder runs. |
| `deploy/deploy.sh <host> fetch runs ./runs` | Copy the match traces out, for `bun run analyze`. `fetch recordings` gets the TikTok segments. |
| `deploy/deploy.sh <host> down` | Stop it. |
| `ssh root@<ip>`, then `docker compose -f /opt/jeviatus/stream/compose.yml exec stream bash` | A shell in the container. |

Signs of an undersized server: logs full of ffmpeg warnings about dropped or duplicated frames, or the stream looking choppy on Kick. With `top` on the server, a high `st` (steal) value means neighbors are taking the shared CPUs. Rescale to a CCX23 in that case.

## Cloudflare Turnstile

openfront.io runs a Cloudflare check on the site, and a Turnstile token on every first join of a match. The game server verifies the token together with the player's IP. Cloudflare scores datacenter IPs like Hetzner's lower than home connections, so a server is more likely than the Mac to get an interactive "verify you are human" check.

What the stream has going for it: a real, non-headless Chromium, which Cloudflare's checks see with its real TLS, real X11 mouse movement (xdotool), and a persistent profile with cookies on `/data`. What counts against it: the datacenter IP, and a software renderer (llvmpipe). The stream hides the renderer from OpenFront's own page, but not from Cloudflare's iframe. Nobody has tested this from a server yet, which is what the dry run is for.

**What the stream does:** it never tries to solve a challenge. The band shows a notice, the log says `Cloudflare wants a human check before joining` or `Cloudflare is checking this browser`, and it tries again 5 minutes later. To count them:

```sh
ssh root@<ip> 'docker logs jeviatus-stream-1 2>&1 | grep -c Cloudflare'
```

**If challenges are frequent**, try these in order:

1. **Try another IP.** IP reputation varies. Create a server in another Hetzner location (or assign a new Primary IP), deploy to it, and delete the old one. It's billed hourly, so each try costs cents.
2. **A static residential ("ISP") proxy for the browser only.** Set `STREAM_PROXY=http://<proxy ip>:<port>` in `.env` and run `up` again. Only Chromium's traffic uses it: pages, the game's websocket and Jev's API calls, a few GB a day at most. The video upload to Kick goes straight from the server. Chromium can't send a username and password to a proxy from the command line, so pick a provider that authenticates by **IP allowlist**: add the server's IP in their dashboard. Static ISP proxies with unmetered traffic cost a few dollars per IP per month (IPRoyal, Webshare and Proxy-Cheap all sell them). Avoid rotating per-GB residential pools: a new IP mid-match can fail the join check.
3. **Your home connection as the proxy.** Install [Tailscale](https://tailscale.com) on the server and on an always-on machine at home (a Raspberry Pi is plenty), and run a SOCKS proxy on the home machine, e.g. `ssh -N -D 0.0.0.0:1080 localhost`, or `microsocks`. Then set `STREAM_PROXY=socks5://<home tailscale ip>:1080`. OpenFront sees a home IP, like it does now. This costs nothing but needs the home machine up.
4. **Fall back to the Mac:** `down` on the server, `bun run live` on the Mac.

Also keep the fair-play point in [stream/README.md](../stream/README.md#limits-worth-knowing) in mind: a bot playing public lobbies around the clock from a server is exactly what Turnstile exists to slow down. Asking OpenFront's maintainers first is the durable fix.

## Claude Code for the lab

The lab (live coding between matches) runs `claude -p` in the container. The image ships Claude Code 2.1.283 (`CLAUDE_CODE_VERSION` build arg, auto-update off). It has no login of its own, so `.env` needs one of these:

- **`CLAUDE_CODE_OAUTH_TOKEN`**: run `claude setup-token` on the Mac. It opens the browser, and you log in with your Claude Pro or Max account. It prints a long-lived token (about a year). Usage counts against **your subscription's limits**, the same pool as your own Claude Code use. A lab change runs every 4 games (`STREAM_LAB_GAMES_PER_BUILD`), so roughly 10 to 25 runs a day, each up to 12 minutes (`STREAM_LAB_MAX_MINUTES`). That can eat a Pro plan's weekly allowance. Revoke the token at [claude.ai → Settings](https://claude.ai/settings) if it leaks. Subscription plans are meant for your own use of Claude Code. For an unattended public service, an API key is the unambiguous choice.
- **`LAB_ANTHROPIC_API_KEY`**: an Anthropic API key from [console.anthropic.com](https://console.anthropic.com), billed per token. It's separate from the commentator's `ANTHROPIC_API_KEY` on purpose, so the lab never spends that key by accident. The lab screen shows each run's cost (`done ($1.23)`). Expect roughly $0.50 to $3 a run with the default model, so $10 to $60 a day. Setting `STREAM_LAB_MODEL=sonnet` makes each run cheaper. Set a monthly spend limit in the Console.

If both are set, the subscription token wins. Only the `claude` process receives it. Every other command the lab runs (typecheck, tests, git) gets the scrubbed environment, and the lab screen masks the token like every other secret. Without either one, the stream logs a warning at startup and every lab change fails on screen with "Not logged in". `STREAM_LAB=false` turns the lab off.

The lab's commits (`jev-lab/…` branches) live in the container's copy of the repository. A redeploy replaces it. The lab then starts over from a new baseline (it logs `starting over from a new baseline`) and keeps its list of past attempts. To keep a change the lab made, copy its branch out before redeploying:

```sh
ssh root@<ip> 'docker exec jeviatus-stream-1 git -C /app bundle create - --branches="jev-lab/*"' > lab.bundle
git fetch lab.bundle 'refs/heads/jev-lab/*:refs/heads/jev-lab/*'
```

## The site

The landing site (`site/`) is static and deploys on Cloudflare Pages from `main`, as described in the [root README](../README.md#deploy). It is not part of this server. The repository is private, and GitHub Pages needs a paid plan for private repositories, while Cloudflare Pages is free. In the morning, go to Cloudflare → Workers & Pages → Create → Pages → Connect to Git, pick `alexandre-schaffner/jeviatus`, and use the build settings from the README (`bun install --frozen-lockfile && bun run build:site`, output `dist/site`, `BUN_VERSION=1.3.14`). Then put the URL in `governance/config.json` → `site`.

While the repository is private, viewers can't see or 👍 strategy PRs. The stream's ballot also only reads it with a `GITHUB_TOKEN` that has access. See "Voting needs a public repo" in [stream/README.md](../stream/README.md#limits-worth-knowing).
