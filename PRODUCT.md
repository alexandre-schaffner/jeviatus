# Product

## Register

brand

## Users

Three overlapping groups arrive at the landing page, usually from a link in an OpenFront community, a stream or a crypto/AI thread:

- **OpenFront players** who know the game and have opinions about strategy ("never open a second war"). Most don't write code. They want to see how Jev thinks and change it in words.
- **Developers and AI builders** curious how a model plays a real-time game through typed questions. They read the source, the decision graph and the pipeline guards.
- **DAO participants** who hold the token and vote on Snapshot. They need to know what is on the ballot and how a passed vote reaches the game.

The job: understand in one scroll that Jev's strategy is a file of plain-English prompts, see those prompts verbatim, and get to the editor to propose a change.

## Product Purpose

Jeviatus is an open AI player for OpenFront. Every decision comes from prompts in `harness/decide/questions.ts`; anyone can rewrite one in the editor, argue it on the forum and put it to a Snapshot vote, and a bot opens the pull request when it passes. The landing page is built from that same file at build time, so it always quotes the prompts Jev is playing by.

Success: a visitor opens the editor with a specific change in mind, or votes on a live proposal.

## Brand Personality

Open, exact, playful. The page shows its work: real prompt text, real constants, the commit it was built from. The voice is specific and plain (a game-strategy friend explaining a system), never hype. The playfulness lives in the territory-map motion and the variable-width type, not in jokes.

## Anti-references

- Crypto DAO landing pages: token price tickers, roadmap rockets, "join the community" with no substance, gradient orbs.
- AI product SaaS pages: "powered by AI" hero, three feature cards with icons, testimonial carousels, hero metrics.
- Esports/gaming sites drowning in neon glow and glitch effects.

## Design Principles

1. **Quote, don't claim.** Show the actual prompt, number or diff. Every figure on the page comes from the source at build time.
2. **The game is the texture.** Pixel territory, tiles and fronts carry identity; decoration that isn't from OpenFront doesn't belong.
3. **Plain English first, code second.** A non-coder should be able to reach the editor without reading TypeScript; the code is there for those who want it.
4. **Honest state.** When voting or the forum isn't live, say so plainly and point to what works today.
5. **One idea per screen.** Long scroll, each section makes one point and hands off to the next.

## Accessibility & Inclusion

WCAG 2.2 AA. Body text ≥4.5:1 on the dark ground. Everything scroll-driven (tree, levers, timeline) must read correctly with `prefers-reduced-motion: reduce`, where Lenis and GSAP are skipped. Colour never carries meaning alone: picked routes use colour plus position and weight. Keyboard access to every tree node and prompt dialog.
