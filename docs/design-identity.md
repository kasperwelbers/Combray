# Visual identity

Combray should feel warm and comforting: like a familiar kitchen on a Sunday morning, or an old photo album found in a drawer. Participants are looking at intimate traces of their own life, often with a stranger sitting beside them. The design should lower their shoulders, not raise them.

## The metaphor

In *Swann's Way*, the narrator dips a madeleine in lime-blossom tea, and from that one taste the whole village of Combray rises up: the church, the streets, his aunt's house, the two walks. The tool borrows this:

- **The madeleine** is the trace: one small thing that brings back a lot. It is the logo.
- **Combray** is the place the traces rebuild: the participant's past, shown back to them. The town is the backdrop of the app.
- **Tea (tilleul)** is the warmth around it: soft light, slow pace, a cup between two people talking.

Use the metaphor lightly. It sets the mood; it should never make the interface harder to understand. Labels stay plain ("Your YouTube history"), and Proust references live in illustration, empty states and the occasional quote, not in navigation.

Possible gentle touches:

- *Two ways.* Combray's two walks, Swann's Way and the Guermantes Way, could frame the two main paths in the app: **exploring** your data and **sharing** it. Only if it helps rather than confuses; test with participants.
- *The town fills in.* As the participant imports data sources, houses in the background illustration light up, one window per source. Progress without a progress bar.
- *Time of day.* The background moves from morning to evening light over a long session, very subtly (off when reduced motion is on).

## Logo

A madeleine, seen from above or at a slight angle, showing its scallop-shell ridges. Simple enough to work at 16 px as a favicon, warm golden brown. Optional variants: a madeleine with a small cup of tea, and a wordmark "Combray" in the heading serif. The scallop shell also nods to the shell shape the madeleine is baked in, and to collecting things by the sea.

## The town

A nostalgic, slightly hazy illustration of a small French village: the steeple of the church of Saint-Hilaire, rooftops, a garden gate, hawthorn hedges, a path leading out of town. Watercolour or soft gouache style, low contrast so it never competes with data. Used:

- Full scene on the welcome and lock screens.
- A thin skyline band at the bottom or top of working screens.
- Small vignettes in empty states ("Nothing here yet. Shall we fetch your first memories?").

The illustration should be commissioned (or carefully generated and then hand-finished) with an open licence compatible with the project.

## Colour

Warm, low-saturation, paper-like. A starting palette to refine with a designer:

| Token | Role | Suggested value |
| --- | --- | --- |
| `paper` | background | `#FBF6EC` (warm cream) |
| `ink` | body text | `#3B2F2A` (dark brown, not black) |
| `madeleine` | primary accent | `#C98A3D` (baked gold) |
| `tilleul` | secondary accent | `#B9C48A` (lime-blossom green) |
| `terracotta` | emphasis, warnings | `#B5623F` |
| `dusk` | links, selection | `#6E6A9E` (evening lavender) |
| `hawthorn` | highlights | `#E8B7B0` (soft pink) |

Charts use a categorical palette derived from these, tested for colour vision deficiencies and WCAG AA contrast. A dark theme ("evening in Combray") uses deep blue-brown backgrounds with the same warm accents.

## Typography

- Headings: a humanist serif with literary warmth (e.g. EB Garamond, Cormorant, or Fraunces at low contrast).
- UI and body: a friendly, very legible sans (e.g. Source Sans 3, Atkinson Hyperlegible, or Nunito Sans).
- Generous size (participants may be reading with an interviewer at an angle), generous line height, short line length.
- Fonts are self-hosted (no Google Fonts requests, see the privacy doc).

## Interface principles

- **As simple as possible.** One main action per screen. Advanced options live behind "more".
- **Unhurried.** No timers, no countdowns, no "only 2 steps left!". Progress is shown, not pushed.
- **No dark patterns around consent.** "Share" and "don't share" are equally easy and equally prominent. Declining is never framed as a loss.
- **Soft motion.** Gentle fades and page-turn transitions, nothing bouncy. Respect `prefers-reduced-motion`.
- **Tactile.** Cards that look like postcards and photo prints for items; rounded corners; subtle paper texture.
- **Large targets.** Touch-friendly, for tablets in interview settings.

## Tone of voice

- Warm, plain, second person: "This is your YouTube history from 2019 to today."
- Curious, not judgemental: "You watched a lot in March 2021. Do you remember why?" never "You spent too much time on…".
- Honest about privacy in one sentence, with details one click away: "Your data stays on this computer. Nothing is shared unless you choose to."
- Dutch and English written natively, not translated word by word.

## Open questions

- Who designs the illustration and logo? A commissioned illustrator would give the strongest result.
- How strongly do we lean on the Proust references in copy? Recommendation: light touch, tested with a few participants who have never heard of Proust.
- Should individual studies be able to theme Combray (their own colours and logo), and how much of the town stays?
