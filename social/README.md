# Posting clips to social media

`bun run clips` (or the watcher, see [clips/README.md](../clips/README.md)) writes vertical videos to `~/Library/Application Support/jeviatus/clips/<YYYY-MM-DD>/`, each with a sidecar `<id>.json` holding the post text for every platform. `bun run social:post` posts that queue:

```sh
bun run social:post --dry-run --env-from .env        # what would go out now; sends nothing
bun run social:post --env-from .env                  # post what the pacing allows now
bun run social:post --env-from .env --clip evo-1a2b3c4-verdict --platforms youtube,x
```

- **Credentials** come from the environment, or from `--env-from <file>`. That flag reads only keys starting with `X_`, `REDDIT_`, `YOUTUBE_`, `IG_`, `TIKTOK_` and `SOCIAL_`, never the stream keys.
- **Platforms without credentials are skipped**, so you can set them up one at a time.
- **No double posts:** every post is appended to `clips/social-posted.jsonl`, and a clip is never posted twice to the same platform.
- **Tokens that rotate** (TikTok refresh tokens, the Instagram token) are saved in `clips/.social-tokens.json` (mode 0600), which takes precedence over `.env`.
- **Pacing** ([queue.ts](queue.ts)): each run posts at most one clip per platform. Clips go out in this order: evolution clips first, then compilations, whole-game highlights, and single moments, newest first. A platform never gets two clips of the same game within 24 hours.

| Platform | Max per 24 h | Min gap | Hard platform limit |
| --- | --- | --- | --- |
| YouTube | 3 | 3 h | 100 `videos.insert` calls/day |
| X | 4 | 2 h | 100 posts/15 min/user; pay-per-use credits |
| Instagram | 2 | 5 h | 100 API posts/24 h |
| TikTok | 3 | 3 h | 5 pending inbox uploads/24 h |
| Reddit | 1 | 24 h | plus a gap per subreddit (Openfront 3 d, others 7 to 14 d) |

To post on a schedule, run it hourly from cron (`crontab -e`):

```
0 * * * * cd /path/to/jeviatus && /Users/alex/.bun/bin/bun social/post.ts --env-from .env >> ~/Library/Logs/jeviatus-social.log 2>&1
```

Before scheduling it, dry-run it once.

## Morning setup, per platform

Easiest first. Put each value in `.env` in the checkout you run from. The API facts below were checked in September 2026.

### 1. YouTube Shorts (Data API v3)

1. In https://console.cloud.google.com, create a project and enable **YouTube Data API v3**.
2. Set up the **OAuth consent screen**:
   - User type: External. Add the scope `https://www.googleapis.com/auth/youtube.upload`.
   - Add the channel's Google account as a test user.
   - Then **publish the app to "In production"**. In "Testing" mode, refresh tokens expire after 7 days. You can click through the "unverified app" warning for your own account.
3. Under Credentials, create an **OAuth client ID** of type **Desktop app**. Put its ID and secret in `.env` as `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET`.
4. Run `bun --env-file=.env social/auth.ts youtube`. Open the printed URL and sign in as the channel. The command then prints `YOUTUBE_REFRESH_TOKEN=...`; put that in `.env`.
5. Optional: set `YOUTUBE_PRIVACY` to `public` (the default), `unlisted` or `private`.

**Catch:** until the project passes the **YouTube API Services audit**, YouTube forces every API upload to **private**. Apply at https://support.google.com/youtube/contact/yt_api_form. It asks for a privacy policy, terms and a description of the use case, and approval takes weeks. Until then, the posted videos appear in YouTube Studio as private; flip them to public by hand there.

**Rules:**
- A vertical video of 3 minutes or less is a Short automatically; `#Shorts` in the title is just a hint.
- An upload costs its own quota bucket (100 per day by default).
- Don't upload many near-identical videos: YouTube's spam and repetitive-content policy applies to channels, not just videos.

### 2. X

1. Go to https://console.x.com (the developer console) and create a Project with an App.
   - New developer accounts in 2026 are **pay-per-use**: buy a few dollars of credits and set a spending cap.
   - A post costs about $0.015, but a post containing a URL costs about $0.20. That's why the X text names the stream ("Live on Kick: jeviatus") instead of linking it. Put the link in your bio.
2. In the App's settings, turn on **User authentication** with the permission **Read and write**. Then, under Keys and tokens, generate the **Access Token and Secret** for your own account. Do it after switching to read and write, or the token will be read-only.
3. Put the four values in `.env`: `X_API_KEY` and `X_API_SECRET` (consumer keys), `X_ACCESS_TOKEN` and `X_ACCESS_TOKEN_SECRET`. These are OAuth 1.0a keys and don't expire.

**Rules:**
- Automated accounts must carry the **"Automated" label**: Settings → Your account → Account information → Automation, linked to your personal account.
- No duplicate or near-duplicate posts, and no posting the same clip from several accounts.

### 3. Instagram Reels

1. Switch the Instagram account to a **Professional account** (Creator or Business). No Facebook Page is needed with the "Instagram API with Instagram Login".
2. At https://developers.facebook.com, create an app with the **Instagram** use case, and choose "API setup with Instagram login".
3. Add your Instagram account under App roles → **Instagram testers**, then accept the invite in the Instagram app.
   - Accounts you own only need Standard Access, which requires no App Review.
4. Set the OAuth redirect URI to any HTTPS page you control, for example `https://github.com/alexandre-schaffner/jeviatus`. You'll copy the `code` from the address bar.
5. Put `IG_APP_ID`, `IG_APP_SECRET` and `IG_REDIRECT_URI` in `.env`. Then:
   - Run `bun --env-file=.env social/auth.ts instagram`, open the URL, and approve.
   - Run `bun --env-file=.env social/auth.ts instagram --code <code>`.
   - Put the printed `IG_USER_ID` and `IG_ACCESS_TOKEN` in `.env`.
   - The token lasts 60 days; the poster refreshes it weekly.
6. **Instagram downloads the video from a public HTTPS URL**, so the clips must be reachable from the internet. Pick one:
   - `SOCIAL_PUBLIC_BASE_URL=https://<bucket-domain>/clips`, with the clips root synced there, for example `rclone sync ~/Library/Application\ Support/jeviatus/clips r2:jev/clips --include "*.mp4"`.
   - `SOCIAL_PUBLISH_CMD='<command that uploads "$1" and prints its public URL>'`.

**Rules:**
- 100 API-published posts per 24 h.
- Reels must be 3 s to 15 min; the clips are H.264 with faststart, as required.
- The API allows 5 hashtags per post.

### 4. TikTok (Content Posting API)

1. At https://developers.tiktok.com, create an app. Add **Login Kit** and **Content Posting API**.
   - The redirect URI must be HTTPS and static (the GitHub page trick works).
2. Put `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` and `TIKTOK_REDIRECT_URI` in `.env`. Then:
   - Run `bun --env-file=.env social/auth.ts tiktok` and approve as the TikTok account.
   - Run `bun --env-file=.env social/auth.ts tiktok --code <code>`.
   - Put `TIKTOK_REFRESH_TOKEN` in `.env`. It is valid for a year and rotates; the poster keeps the newest copy.
3. The default mode is **inbox** (`video.upload` scope): the clip lands in the TikTok app's inbox and notifications. You open it, add a trending sound, paste the caption from the sidecar, and post.

**Why inbox and not direct post:**
- Unaudited apps can only direct-post as **private (SELF_ONLY)**, to private accounts only.
- TikTok's audit rejects "a utility tool to help upload contents to the account(s) you or your team manages", so an own-account poster won't pass.

`TIKTOK_MODE=direct` (with the `video.publish` scope) is there if that ever changes. It sends `TIKTOK_PRIVACY` only when the account allows it.

**Rules:**
- At most 5 pending inbox shares per 24 h.
- No watermarks or promotional overlays added by the tool.
- Disclose branded content if a post is paid.

### 5. Reddit (hardest: API access needs approval)

1. Since the **Responsible Builder Policy** (November 2025), every new API client needs Reddit's **approval before use**, personal scripts included.
   - Create a "script" app at https://www.reddit.com/prefs/apps (redirect URI `http://localhost:8080`).
   - Then request access through Reddit's developer support form, describing it as a personal script posting your own clips a few times a week.
   - Small projects may wait a long time or be declined. **Until approved, post by hand** using the sidecar's `platforms.reddit.title` and subreddit.
2. After approval, put `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME` and `REDDIT_PASSWORD` in `.env`. The account must not use 2FA for the password grant. Optionally set `REDDIT_USER_AGENT`; the default is `macos:jeviatus-clips:0.1 (by /u/<you>)`.

**Rules:** keep self-promotion at or under 10% of the account's activity, and take part in the communities too. API rate limit: 100 requests per minute.

**Subreddits** (checked 2026-09; the sidecar picks per clip kind, see `SUBREDDITS` in [clips/metadata.ts](../clips/metadata.ts)):

| Subreddit | Fits | Rules that matter |
| --- | --- | --- |
| r/Openfront | everything | The game's own, very active sub. Video posts are common, and an AI-plays-OpenFront post has precedent. Flair the post and say plainly that it's an AI playing public lobbies. |
| r/Kick | gameplay | Clips are OK if the content is the focus; channel promotion goes only in the monthly thread, so no link in the post. |
| r/territorial_io | compilations | Neighbouring territory-game sub (~7k); flair is mandatory. |
| r/StrategyGames | compilations, evolution | "Self-Promotion" flair, at most one self-promo post a week, 10% rule. |
| r/artificial | evolution | 10% rule, the account's first post can't be promo, no clickbait. |
| r/ClaudeAI | evolution | Must be about Claude (the lab's changes are written by Claude Code); flair required; disclose that it's yours. |

**Avoid:**
- r/gaming: videos are disabled and self-promo is barred.
- r/IndieGaming: no let's-plays or streams.
- r/singularity: no self-promotion.
- r/AI_Agents: text posts only, with projects in the weekly thread.
- r/WebGames: link to the game only.
- r/IoGames: posts must link the game page.

Also consider r/ClaudePlaysPokemon, a small "AI plays a game" crowd.

### Kick

Kick's public API (docs.kick.com) has **no clip endpoints**: no creating or listing clips. The clips here come from the stream's own recording instead.

## Content notes

- Every post says Jev is an AI. Keep it that way: platforms and subreddits treat undisclosed automation as spam.
- The gameplay is real footage, so `is_aigc` (TikTok) and `containsSyntheticMedia` (YouTube) are off. The AI plays the game; it doesn't generate the images.
- Most players Jev "wipes out" are OpenFront's built-in nations, not people. The post text says what happened ("Jev wiped X off the map") and never claims the victim was a human.
