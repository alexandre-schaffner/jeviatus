# Clavicular: what makes his short clips perform (research for clip-scoring questions)

Researched 2026-10-03. Read-only, no logins. Raw data (reel CSV, cover grids) was left in the workspace's `.context/clav/`, which is not committed.
- `clav/clavicular_reels.csv`: all 360 reels from @clavicular's reels tab (2025-04-15 to 2026-09-28). Columns: plays, likes, comments, duration, posted date, a Kick-watermark flag, caption, and a Whisper transcript where one was made (~100 reels).
- `clav/green_grid1.jpg`, `clav/green_grid2.jpg`: cover thumbnails of the 51 Kick-watermarked stream clips, labelled with plays. Useful for seeing the on-screen text style.
- `clav/frames/*.jpg`: contact sheets of the top-45 and bottom-12 reels.

## 0. What I could and couldn't verify

| Source | Status |
|---|---|
| **Instagram @clavicular** (the real account: 1,043,342 followers, bio links camplooksmax.com) | **Verified.** Pulled through IG's public web endpoints with no login. I have exact play counts, likes, comments and durations for 360 reels. I downloaded ~95 videos and transcribed them with Whisper-small (local, mlx). Note that @clavicular0 (cited by KYM) and @clavicular1.0 are older or credit handles. |
| IG clip pages (@clavclips 618 followers, @clavicular_clips 348, @clav.clips 15) | Verified, but these pages are tiny (≤47K plays). I could not find the big clip-farm accounts behind the Kick program. IG search needs a login, and those pages usually aren't named after him. |
| X/Twitter viral posts (ASU frame-mog, judge, burger, Vance/Newsom) | **Second-hand.** Numbers come from Know Your Meme snapshots, not checked live. |
| YouTube Shorts | Verified view counts via `yt-dlp` search (~280 Clav-titled shorts ≤180 s). These are mostly podcast clips and react channels, not stream clips. |
| TikTok @kingclavicular | Failed. The profile returns status 10223 (probably banned or removed). The only TikTok number I have is KYM's: 7.9M views on a Nov 15 2025 video. |
| Reddit r/LivestreamFail | Blocked (403/429). The only numbers are KYM's (Cybertruck post: 14K upvotes). |

**Biases to keep in mind:**
1. IG "plays" count replays, so very short clips get inflated.
2. His follower count grew roughly 10x over the window. To compare like with like, I mostly look inside one window (Mar–May 2026).
3. @clavicular reposts the best clips the clip farm produces, so its stream-clip reels are already pre-selected winners. The ~70K clips/month the clippers post are not visible here.
4. Industry context, from [LADN](https://www.ladn.eu/media-mutants/clavicular-comment-kick-et-le-clipping-ont-cree-une-star-toxique/), [The Star/Bloomberg](https://www.thestar.com.my/tech/tech-news/2026/05/03/the-video-clipping-machine-behind-claviculars-viral-fame) and [Dexerto](https://www.dexerto.com/kick/clavicular-says-kick-spent-nearly-700000-promoting-his-clips-in-a-single-month-3393030/):
   - In one month: 1,610–1,737 clippers, about 70K clips, 2.2B views.
   - Kick pays $30 CPM and spent about $700K on his clips that month.
   - Every clip carries a "KICK / kick.com/clavicular" watermark.

## 1. The clips

### 1a. @clavicular Instagram reels: Kick-watermarked stream clips

All are verified. URL = `https://www.instagram.com/reel/<code>/`. "On-screen text" is the burned-in caption I read off the cover frame. The core line comes from the transcript.

| # | code | posted | plays | likes | dur | On-screen text / caption | What happens (first line → payoff) |
|---|---|---|---|---|---|---|---|
| 1 | DVfFqcjke3c | 2026-03-05 | **6.46M** | 313.7K | 28s | "And then there's the people who pay for it" 😭🥀 / cap "Life lesson" | Yacht party. A woman asks why he's dressed up. He explains people come to "get in hot tubs… and then there's people who pay for it" (implying she's paid). She goes silent. |
| 2 | DVpPfIUCFgE | 2026-03-09 | **4.38M** | 176.7K | 29s | "So you're 26 years old?" 😭 / "Always check id" | He checks a girl's ID on the street ("you look like you're 15… you're trying to get me in trouble, get out of here"). |
| 3 | DaI3FbIRUrN | 2026-06-28 | 1.96M | 56.0K | 16s | "Are you guys from Agartha" | Drunk, he can't understand foreign women's accents: "Are you from Agartha or some sh**?" |
| 4 | DVjSkYfjDdA | 2026-03-06 | 1.49M | 22.4K | 20s | "the moment clav finds out one of the girls on his yacht was born in 2009" | ID check, born 2009. He reacts. |
| 5 | DVrzOG8kcnf | 2026-03-10 | 1.34M | 23.9K | 11s | "That's my boyfriend" | A woman with her boyfriend; quick awkward exchange. |
| 6 | DWnQm8mJpFs | 2026-04-02 | 1.31M | 40.0K | 16s | "you're plastic maxing.." 😭💔 / "She had nothing to say😂" | He tells a woman to her face she's "plastic maxing". She denies surgery. |
| 7 | DcdAjt2RSiT | 2026-08-25 | 1.21M | 39.3K | 12s | (club, music) | Club/nightlife b-roll with a song. |
| 8 | DXFHKblpzTj | 2026-04-13 | 1.00M | 5.8K | 11s | "Clavicular's rizz needs to be studied" | Restaurant date: "You're not gonna eat?" / "I ate my perfume" / "You have a rat." Absurd non-sequitur. Note the high comment ratio (1,019 comments). |
| 9 | DW2EIiuJ1fN | 2026-04-07 | 950K | 20.9K | 14s | (barber) / "Why would I damage my hair😭" | Barber asks "is that a perm?" He replies: "Number one way to damage your hair." |
| 10 | DYhtHH8xVjQ | 2026-05-19 | 946K | 16.5K | 9s | "CLAV CATCHES A FOOTBALL WITH ONE HAND!" | He announces "I'm gonna get it one hand" and does it. Pure spectacle. |
| 11 | DUU5wjEjveU | 2026-02-04 | 929K | 15.2K | 9s | "It sounds pretty cringe.." | A guy pitches sales as a career. Clav: "Can you sell yourself to some bitches?" |
| 12 | DVmfNx7jACU | 2026-03-07 | 842K | 11.2K | 15s | "CLAV Just Stole His Fan GF" / "ggs" | "You want to come to the club later?… Not we, your homeboy's gotta go." The girl ditches her friend. "Sorry bro." |
| 13 | DWzwj68Jzva | 2026-04-06 | 824K | 9.8K | 16s | "Clav was completely uninterested after she did this" | "Okay, talk." … "Now you have nothing to say. I don't really like you as much." |
| 14 | DXC8Jy0payr | 2026-04-12 | 819K | 13.0K | 8s | "what does that mean" / 😭😭😭 | "Lucky I'm practicing my cold approach today." Confused women. |
| 15 | DVlfsjGjFhd | 2026-03-07 | 817K | 16.0K | 9s | "WHEN THE WEIRD BRO'S RIZZ ACTUALLY WORKS" / "W mans" | A random guy's outrageous one-liner lands. |
| 16 | DW1osjmp3Te | 2026-04-07 | 793K | 16.4K | 10s | "bros clearly got a type.." / "Why are they all identical?" | He notices a guy's group of girls all look alike. |
| 17 | DWMfi4ekfBO | 2026-03-22 | 765K | 15.5K | 18s | "Definitely didn't say that" | He-said-she-said callout in a group, then denial. |
| 18 | DXDgHTep81j | 2026-04-13 | 746K | 9.1K | 14s | "Clavicular kicks jester out of his party for self promotion" / "He kept trying" | "You can't just come here and try to sell your course… get out." |
| 19 | DXAyw9DJAw6 | 2026-04-12 | 701K | 7.4K | 19s | "Clavicular steals his girlfriend after she finds out he's famous" | "Is that your man?… Tell that loser to f\*\*\* off." |
| 20 | DWl-JYvp16q | 2026-04-01 | 643K | 11.3K | 18s | "Well turn the lights off" | He looks a woman over ("Stand up, let's see the back of you"), then "turn the lights off". |
| 21 | DYiL9hPRpV0 | 2026-05-19 | 641K | 11.2K | 12s | "You're here to date grace not me brotha" | A stranger interrupts to gush that "Clav mogs". He deflects. |
| 22 | DYfUDq6xBw2 | 2026-05-18 | 628K | 13.9K | 23s | "Clav HEARTBROKEN when encountering EVIL women taking ADVANTAGE of guy who CAN'T get GIRLS" | "You're an evil person… 80% of women go for top 20% of men." Moral lecture aimed at a stranger. |
| 23 | DWts_OvkSzn | 2026-04-04 | 603K | 10.9K | 5s | "Mfs say maxxing behind everything now" / "Chic fil a maxing" | Lingo coinage in 5 seconds. |
| 24 | DWuH9sRpS19 | 2026-04-04 | 542K | 11.2K | 14s | "These girls COULDN'T BELIEVE Clavicular CREATED the TERM 'maxxing'" | "Calorie maxing, jester maxing… all those are my terms." |
| 25 | DWpFVFzp6rw | 2026-04-02 | 522K | 7.5K | **57s** | "Clavicular was shocked when she revealed this" | Age-gap ex reveal: "So you're a pedophile?" Long setup. |
| 26 | DWr-tSMp2BU | 2026-04-03 | 497K | 9.8K | 20s | "Clav tells his new girlfriend he'll TRADE her in a second for BURGER KING" | "I would trade you in a second for a whopper." |
| 27 | DWXCgvqAZQ6 | 2026-03-26 | 470K | 10.7K | 19s | "I just like status maxing" | Fan asks for his game; he admits "my game is terrible, I just status max and looks max". |
| 28 | DWmxnr2Je9u | 2026-04-01 | 398K | 9.7K | 15s | "YOUR DONALD TRUMP MAXING RIGHT NOW" | Lingo applied to a girl; she says "I'm not political." |
| 29 | DWum3kDpwZ4 | 2026-04-04 | 289K | 2.9K | 42s | "Had to stand up for Ed" | Panel-show format: a girl picks his "twin" over him. Long. |
| 30 | DWwRUb6pM7l | 2026-04-05 | 210K | 2.5K | 37s | (sit-down) | Monologue on why young men shouldn't talk politics. |
| 31 | DWpnrh6pHkm | 2026-04-03 | 185K | 2.3K | 54s | (sit-down) | A guest prays over him. |
| 32 | DWrqHnNpZ3O | 2026-04-03 | 172K | 2.0K | 43s | "I genuinely can't even cold approach anymore" | Reflective monologue about fame. |

### 1b. @clavicular reels: other formats, for contrast

| code | owner | plays | dur | Format | Content |
|---|---|---|---|---|---|
| Ddm2mrwvAl5 | clavicular | **6.56M** | 12s | Response edit | Posted the day the rape charge broke (2026-09-22). Selfie on a boat, overlay "There's better ways to make money than suing someone because they don't want you", then the accuser's DMs and handwritten letter as receipts. Caption "Greed is a sin". |
| DSJM4KeEYKc | clavicular | 6.19M | 13s | "POV: you ascended a follower" | Before/after edit, music, "Does clav's protocol", CTA "DM COACH". |
| DZ1i-XiK6IA | clavicular | 5.85M | 8s | Romance b-roll | Paris, Seine, flowers, a hug. No dialogue. |
| DYkZI_Px7l0 | impaulsiveshow | 5.59M | 24s | Podcast rating | "What do you rank Timothée Chalamet?" → "6.25… he's only gonna get girls that are on birth control." |
| DU6Jd0uCV8e | theadamfriedlandshow | 5.27M | 47s | Podcast hot take | "Use your college loans for surgery instead of school." |
| DQLArsikeST | clavicular | 4.67M | 9s | Face-card selfie + music | Thirst/aesthetic. |
| DRkKnzGEYFl | clavicular | 4.64M | 14s | Physique side-by-side | Shirtless mirror flex next to a bigger guy. |
| DU8SrOjiTHR | theadamfriedlandshow | 4.29M | 36s | Podcast hot take | "Would you rather lose your hair or your d\*\*k?" |
| DRg1lJvjgZK | clavicular | 4.01M | 16s | Follower transformation | "Ascending one of my followers", before/after. |
| DYaDUZVxmaB | impaulsiveshow | 3.77M | 14s | Podcast | "Are you on the spectrum?" "Yeah, I'm neurodivergent." |
| DdfFupah0kC | clavicular | 3.26M | 10s | Duo pose + music | Poses with a friend; 156K likes (4.8% like rate). |
| DdJ5ix1Ryd1 / DbBezAIR4_T | impaulsiveshow | 3.19M / 2.53M | 24s | Podcast rating | Logan: "Rate my look." → "6.5? Not even a 7… aging." The same clip posted twice still did 5.7M combined. |
| DRPoqIlkc6j | clavicular | 2.93M | 14s | Stream/collab (N3on) | "How many surgeries do you think I had?" → "you have filler… it's migrating down your face." |
| DcZGEmevd4q | clavicular | 2.57M | 10s | IRL | "I was about to do a cold approach… that's a Stacey right there." |
| DRBO9JNDX2U | jackhneel | 2.56M | 24s | Podcast outrageous plan | "$100,000 surgery to go from 6'2 to 6'6", percentile math. |
| DdExIq5RcKv | patrickbetdavid | 2.45M | 109s | Rapid-fire list | "Rules for young men": quick yes/no verdicts ("Over." "Gotta do it."). Long but segmented. |
| DPcsIqRETKr | clavicular | 2.13M | 25s | Monologue hot take | "Would Charlie Kirk have gotten assassinated if he were Chad?", halo effect. 1,266 comments. |
| DK81KWsOkI- | cookiekinggg | 2.19M | 9s | Skit | "Looks don't matter, just be confident…" "It's not that easy." Caption "Brutal". |
| DRSkBhRkXkb | clavicular | 1.70M | 11s | Stream rating | "I give him about an eight and a half." |
| DR22CHaEf75 | clavicular | 1.69M | 19s | Stream chat bit | Chat says "my girlfriend's going to ASU". He replies: "instead of waiting for her to get a black eye, you could black eye yourself." |
| DRIfVc0EbEN | clavicular | 1.80M | 51s | Stream cold approach | A woman says "I don't like shy guys", then he tells her "your maxilla is quite recessed". |
| *Bottom of feed (flops)* | clavicular | 33K–52K | 18–52s | Talking-head looksmax tutorials (Apr–Jun 2025) | Sunscreen PA+++, diet macros, Norwood scale, carotenoids, "consistency is the method". Informational, no second person, no conflict. |

### 1c. Off-Instagram viral moments (mostly second-hand metrics)

| Moment | Where / who posted | Metric | Archetype |
|---|---|---|---|
| ASU frat leader selfie. Clav: "You got me by a lot, I stopped gyming" (Kick IRL, 2026-02-05, ~3:08:00 into the stream) | X @biggerboy111: "Clavicular ran into a frat leader at ASU and got brutally frame mogged by him👀😂" | 13.5M views, 18K likes in 3 days; became a copypasta ([KYM](https://knowyourmeme.com/memes/clavicular-frame-mogged-by-asu-frat-leader)). YT: Matan taxi-driver short 2.38M; "Lessons in Meme Culture" explainer 466K | Clav gets mogged |
| Judge Marcus Bach Armas at the alligator plea hearing (2026-05-15) | X @Pulcys / @Polymarket / @RosieGray | 17.9M / 14.4M / 8.1M views ([KYM](https://knowyourmeme.com/memes/chad-judge-clavicular-mogged-by-judge)) | Clav gets mogged |
| Burger meltdown: cries over cheese on a DoorDash burger (~7h into a stream, 2026-02-26) | X @SinClipd: "Clavicular started to BREAK DOWN in TEARS after finding CHEESE in his Burger" | 12.7M views; TikTok "pouty clav" edit 2.3M ([KYM](https://knowyourmeme.com/memes/clavicular-burger-meltdown-clavicular-crying-over-cheese-on-his-burger)) | Clav's vulnerability / meltdown |
| Cybertruck: drives off with a man on the hood, asks "is he dead", answers "Hopefully" (2025-12-24) | r/LSF; his own X AI image "Play stupid games, win stupid prizes" | 14K upvotes; 4.1M views on the X image ([KYM](https://knowyourmeme.com/memes/people/clavicular)) | Shock / danger |
| "Newsom mogs… Vance obese, recessed side profile… I'm voting Gavin" (Daily Wire, 2025-12-28) | X @Awk20000 | 5.2M views | Outrageous looks verdict on a public figure |
| Paris cafe: "Don't look me up on Google". Woman: "Are you famous?… have a good time in Paris" | Multiple clip accounts; YT "Clavicular Gets Rejected" 459K; Thestreamclipper 146K | ([IBTimes](https://www.ibtimes.co.uk/clavicular-paris-trip-backlash-1804613)) | Clav gets rejected |
| Sophie Rain rejection | YT short "Clavicular Flirts With Sophie Rain But Gets Rejected" (Streamer Radar, 57s) | 1.94M YT | Clav gets rejected |
| Chokehold by CubanTarzan; he convulses (Mog World Order marathon, 2026-04-02); mall collapse/overdose | News-wide; YT explainer 381K | ([AOL](https://www.aol.com/entertainment/manosphere-influencer-starts-convulsing-unimaginably-202520574.html)) | Danger / health scare |
| Girlfriend's photos at a cosmetic clinic: "before and way before" (2026-09-29) | Multiple clip accounts | "hundreds of thousands" ([HypeFresh](https://hypefresh.com/claviculars-girlfriend-reportedly-photographed-at-a-clinic-goes-viral)) | Blunt looks verdict |
| TikTok with girlfriend, "Holy character" (2025-11-15) | @kingclavicular | 7.9M views, 763K likes | Couple / aesthetic |
| Holding a woman's face: "I'm not done looking at you!" | ([Yahoo](https://yahoo.com/news/us/articles/clavicular-online-culture-turns-humiliating-100000546.html)) | n/a | Rating strangers to their face |
| Androgenic (sidekick) gets his wig snatched by a fan | YT WSPEEDGANG 13s | 273K | Sidekick humiliation |
| "Clav's cortisol spike" genre (Matan, MeiClips, Fred Beyer…) | YT shorts, 10–30s | 15K–108K each | Clav flustered (lingo in title) |

## 2. Archetypes, with evidence counts

Counts cover the 32 stream clips in 1a, the 24 rows in 1b and the 13 rows in 1c. Medians are for Kick clips in the Mar–May 2026 window (n=40, median 572K; non-Kick reels in the same window: median 324K).

| # | Archetype | Evidence | Typical reach |
|---|---|---|---|
| A | **Blunt verdict to someone's face**: a looks rating, "plastic maxing", "recessed maxilla", "people who pay for it", "filler migrating", a 1–10 score | 1a #1, 6, 11, 20; 1b N3on filler, 8.5 rating, recessed maxilla, Chalamet/Logan/Majlak ratings; 1c Vance/Newsom, clinic. **~14** | The highest ceiling: 6.46M, 5.59M, 3.2M |
| B | **Status flip / dismissal**: he rejects, kicks out, IDs, or ditches someone ("get out of here", "your homeboy's gotta go", "I don't really like you as much", "trade you for a whopper") | 1a #2, 4, 12, 13, 18, 19, 26, 17. **~9** | 4.38M top; typically 0.5–1.5M |
| C | **Clav gets mogged / rejected / humiliated**: ASU, judge, Paris, Sophie Rain, cortisol spike, sidekick humiliation | 1c ×6, plus YT cortisol shorts. **~8** | The biggest off-platform spread (13–18M on X). He doesn't repost these himself. |
| D | **Vulnerability, meltdown or danger**: crying over a burger, collapse, chokehold, Cybertruck | 1c ×4 | Huge on X and news; IG own-account not applicable |
| E | **Lingo / coinage**: an absurd "-maxxing" applied live ("Chick-fil-A maxing", "Donald Trump maxing", "Agartha", "status maxing", "Peter Pan maxing", "cortisol spike") | 1a #3, 23, 24, 27, 28; 1b PBD; 1c cortisol. **~8** | 0.4–2M. Also supplies the title. |
| F | **Absurd non-sequitur / chaotic stranger**: "I ate my perfume", "We should run an orgy", weird bro's rizz works, identical girls | 1a #8, 14, 15, 16, 5. **~5** | 0.8–1.3M, with high comment ratios |
| G | **Outrageous self-claim or plan**: $100K leg lengthening, loans for surgery, "hair or your d\*\*k", Charlie-Kirk halo effect, neurodivergent | 1b ×6. **~6** (mostly podcasts) | 2–5.6M |
| H | **Spectacle / physical feat**: one-hand catch, physique side-by-side | 1a #10; 1b DRkKnzGEYFl. **2** | 0.9–4.6M |
| I | **Aesthetic / face-card / romance edits; follower before/after**: music, no dialogue | 1b ×8 | 3–6M, but not transcript-derivable. Ignore for stream clipping. |
| **Flop** | Advice monologue, informational tutorial, politics talk, prayer, panel/dinner shows with long setups, anything over 35 s without a verdict | 1a #29–32; 1b bottom; 2025 tutorials. **~17** | 33K–290K |

**Who is in it:** By my hand count, in about 24 of 32 Kick clips, a second person reacts on camera. In ~18 that person is a woman, almost always a stranger at a club, yacht, street or date. A physically contrasting man is the other high-yield foil (ASU frat leader, the judge, the bigger guy in the mirror). Solo-talking stream clips are rare among winners.

## 3. Hook and title formulas (real examples)

**First 2 seconds (from transcripts).** The winners open mid-confrontation, on a question or accusation aimed at a person in frame. There's no setup.
- Question that sets up a judgment: "Why are you wearing a shirt and a shirt on the back?" (6.46M) / "You're actually 21?… why do you lie?" (4.38M) / "Are you guys from Agartha?" (1.96M) / "How many surgeries do you think I had?" (2.93M) / "What do you rank Timothée Chalamet?" (5.59M)
- Accusation: "You're plastic maxing right now" (1.31M) / "You're an evil person" (628K)
- Announcement of a stunt: "I'm gonna get it one hand." (946K)
- The losers open on context: "And there's a lot of other reasons besides…" (210K) / "Well, anyways, God bless you" (185K) / "So let's talk about nofap" (75K)

**On-screen text: three formulas** (white text on a black bar above the video; KICK logo plus kick.com/clavicular below):
1. **Verbatim punchline in quotes + 😭/🥀/💔:** "And then there's the people who pay for it" 😭🥀 · "So you're 26 years old?" · "you're plastic maxing.." · "Well turn the lights off" · "Definitely didn't say that"
2. **Third-person headline, "Clav[icular] + strong verb + object + twist":** "Clavicular kicks jester out of his party for self promotion" · "Clavicular steals his girlfriend after she finds out he's famous" · "CLAV Just Stole His Fan GF" · "Clav tells his new girlfriend he'll TRADE her in a second for BURGER KING" · "the moment clav finds out one of the girls on his yacht was born in 2009"
3. **Reaction framing:** "Clav was completely uninterested after she did this" · "Clavicular was shocked when she revealed this" · "WoahVicky left Clav in tears" · "Clavicular's rizz needs to be studied" · "WHEN THE WEIRD BRO'S RIZZ ACTUALLY WORKS"

**Post captions** are 1–4 words: an ironic moral or a lingo tag. Examples: "Life lesson", "Always check id", "Greed is a sin", "She had nothing to say😂", "Easy decision", "He kept trying", "Chic fil a maxing", "Parismaxing", "Homeless Maxing", "Brutal".

**Clip-page/X style:** ALL-CAPS emphasis words plus 👀😳😭❤️‍🩹 emojis. Examples: "Clavicular ran into a frat leader at ASU and got brutally frame mogged by him👀😂" · "Clavicular started to BREAK DOWN in TEARS after finding CHEESE in his Burger" · "Clav has ACCEPTED his DEFEAT after LOSING very BADLY…" · "MYRON TELLS CLAV TO USE THIS PICKUP LINE AND IT WORKS PERFECTLY😳".

**Length** (Kick clips, Mar–May 2026, median plays):

| Duration | n | Median plays |
|---|---|---|
| <12 s | 7 | 819K |
| 12–20 s | 14 | 672K |
| 20–30 s | 12 | 369K |
| >30 s | 7 | 289K |

Every top-5 stream clip is ≤29 s. Caveat: IG plays count loops, which favours short clips. Even so, the >30 s clips are also the low-like-count ones, so they really are weaker, not just less replayed. The only long winner is the segmented rapid-fire "Rules for young men" (109 s, 2.45M on a big podcast account).

**Practical rule:** a 20–90 s candidate window should contain an 8–25 s core. Start on the line that addresses the other person and end 1–3 s after the punchline or reaction.

## 4. Questions for scoring a 20–90 s candidate moment (transcript + chat + loudness)

Each question is answerable from a speaker-attributed transcript (word timestamps), the chat log (messages/sec, text) and an audio loudness series. Q1–Q4 are the core. Q9 is a hard gate.

1. **Verdict line (0–4).** *Does the streamer deliver a blunt, quotable judgment about a specific person who is present, or a named celebrity: a looks rating, a number score, an accusation about surgery, age or status, or an insult in looksmax vocabulary?*
   - 4 = a short (<12 words), standalone verdict aimed at someone in frame. Examples: "you're plastic maxing", "there's people who pay for it", "6.5, not even a 7".
   - 2 = a general opinion with no target.
   - 0 = none.
   - Evidence: archetype A, including the #1 stream clip (6.46M) and the best podcast clips (5.59M, 3.19M).

2. **Status flip (yes/no + direction).** *By the end of the window, has someone visibly lost status? Either he rejects, dismisses, IDs or kicks someone out, takes a guy's girl, or he gets mogged, rejected, or loses.*
   - Yes looks like an exit line ("get out of here", "your homeboy's gotta go", "I don't really like you as much"), or a third party out-classing him ("you got me by a lot").
   - Tag the direction (`clav_wins` / `clav_loses`). Clav-loses moments travel furthest off-platform (ASU 13.5M, judge 17.9M) but his own account never reposts them.
   - Evidence: archetypes B and C.

3. **Live foil reaction (0–4).** *Is there a second identifiable speaker (ideally a stranger, a woman, or a physically contrasting man) who answers within ~2 s, and whose reply shows the hit landed: denial, stunned short answer, silence, laughter, "what?"*
   - 4 = rapid back-and-forth with a clear reaction beat.
   - 0 = monologue.
   - Evidence: about 24/32 Kick clips have one; the flops are monologues.

4. **Cold-open hook (0–4).** *Can the clip start on a line, spoken in the first 2 s of the cut, that already states the premise as a question or accusation directed at someone? And does the payoff arrive within ~20 s of that line?*
   - 4 = premise line + payoff ≤15 s apart, with no context needed.
   - 2 = it needs ≤5 s of setup.
   - 0 = it only makes sense with prior stream context.
   - Output the proposed in/out timestamps.
   - Evidence: the length table; the first-line examples in §3.

5. **Lingo moment (yes/no).** *Does he coin or apply looksmax jargon (`-maxxing`, mog/mogged, PSL, Chad/Stacy, "ascend", cortisol, Agartha, jester) in a new or absurd way, such that the term could be the title?*
   - Yes = "Chick-fil-A maxing", "Donald Trump maxing", "status maxing", "Peter Pan maxing".
   - Evidence: archetype E (~8 clips). The Bulwark credits his lingo as the main driver of spread.

6. **Outrage / comment bait (0–4).** *Would an ordinary viewer feel compelled to comment, argue or share because the line is shocking, cruel, absurd, or morally loaded (age, paying for women, cheating, surgery extremes, insulting a famous person)?*
   - Higher = more polarizing.
   - Evidence: high-comment outliers ("I ate my perfume" 1,019 comments on 5.8K likes; Charlie Kirk take 1,266); the "most combative, most inflammatory" quote ([TheWrap](https://www.thewrap.com/media-platforms/tv/creators-rise-of-clipping-explained/)).

7. **Chat spike (0–4).** *In the 0–20 s after the payoff line, how does chat compare with the trailing 3–5 min baseline?*
   - Measures: messages/sec ratio, and the share of messages that are reaction tokens (KEKW/LUL/😭/💀, "W"/"L", "mogged", "cortisol", "ratio", "clip it", "CLIP").
   - 4 = ≥3x rate and ≥40% reaction tokens.
   - 2 = ~1.5–2x.
   - 0 = flat.
   - Literal "clip"/"clip it" messages should be a strong bonus, since chat includes clippers being paid $30 CPM.

8. **Audio payoff (yes/no).** *Within 3 s after the payoff line, is there either (a) a loudness burst ≥6 dB above the window median (laughter, crowd "ohh", crosstalk), or (b) ≥1.5 s of near-silence right after a question or verdict (the awkward "she had nothing to say" beat)?*
   - Either counts as yes.
   - Evidence: the payoffs of #1, 6 and 13 are silences or denials; #12 and 15 are crowd reactions.

9. **Negative filter (gate, yes = reject or score down).** *Is the moment mainly any of these: advice or informational monologue, politics talk, prayer/gratitude, a seated panel or dinner-date with long setup, logistics/sponsor reads, or longer than ~35 s with no verdict line?*
   - Evidence: the flop row; Kick clips >30 s (median 289K); 2025 tutorials at 33–52K.
   - Separately, flag segments with slurs, identifiable minors, or sexual content involving possible minors (ID-check/age content is a recurring pattern). These carry platform-ban and legal risk regardless of score. His YouTube channels were terminated and Kick banned him once.

10. **Vulnerability / spectacle (0–4).** *Does the streamer himself visibly break? Crying, panic, being out-classed physically, a fall or collapse, a physical feat, or an "I'm gonna do X" stunt that succeeds or fails on camera.*
   - Evidence: burger meltdown (12.7M on X), ASU, the one-hand catch (946K).
   - Score medical emergencies for safety review, not for posting.

**Suggested combination:** `score = 2·Q1 + 2·[Q2] + Q3 + Q4 + [Q5] + Q6 + Q7 + 2·[Q8] + Q10`, gated by Q9.
- Require Q4 ≥ 2.
- Require at least one of Q1, Q2 or Q10 ≥ 3.

## 5. Caption and title templates

On-screen hook (pick one):
- `"<verbatim punchline, ≤10 words>" 😭🥀`. Use when the line stands alone (Q1 = 4).
- `Clavicular <kicks / steals / rates / IDs / roasts> <person-role> <after/when> <twist>`. Use for status flips (Q2).
- `the moment clav finds out <fact about the other person>`. Use for reveals.
- `Clav was completely <uninterested / shocked / heartbroken> after <she/he> <did this / revealed this>`. Use for reaction beats (Q3/Q8).
- `<Role> just <frame/height/brutally> MOGGED Clavicular 👀😂`. Use when Clav loses (Q2 = loses, Q10).
- `<Noun> maxing` or `Mfs say maxxing behind everything now`. Use for lingo (Q5).
- `Clavicular RATES <celebrity/person> 👀🤔`. Use for number ratings.

Post caption (≤4 words, ironic moral or lingo): `Life lesson` · `Always check id` · `She had nothing to say😂` · `Easy decision` · `He kept trying` · `<X> maxing` · `Brutal`.

Keep the KICK / kick.com/clavicular watermark bar (it's the program's distribution requirement). Show the top text from frame 1, and keep the cut ≤25 s.
