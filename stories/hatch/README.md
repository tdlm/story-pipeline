# HATCH (the series)

A short-form series set in the world of the Hatch game: one survivor, his homemade shelter, the 6:14 broadcast, and the knocks at the hatch. The story truth is the game's `docs/STORY.md`; episodes reveal it the way the game does, in fragments.

## Look and sound

- **Style:** hand-drawn stick-figure comic. Warm amber inside, ash grey outside. Mustard yellow is the one strong color, and it belongs to him: a knit beanie he never takes off, and his hazmat suit up top. That's his "red cap".
- **Narrator:** second person ("you"), like the game.
- **The survivor** speaks rarely, in short mutters like the game's.
- **Writing style:** vary the rhythm. Mix longer, conversational sentences with short ones; use the `*word*` highlight once or twice per shot at most (it also makes the voice lean on that word); let plain lines be plain so the strong ones land; avoid runs of clipped fragments in threes. Most parts open by saying what viewers voted for; a fuller 15 to 20 second recap (premise, recent votes) only every 5 or 6 parts. Narration is in Scott's voice (scottify). Full note: the Hatch project's `writing-style.md` doc.
- **Emotion:** Cartesia voices take an emotion in `settings` (cast.yaml), e.g. `settings: { emotion: scared, speed: 1.1 }`. Primary emotions are the most reliable: `scared`, `angry`, `sad`, `calm`, `content`, `neutral` (full list: docs.cartesia.ai, Sonic 3 "volume, speed, emotion"). It applies to every line that speaker says, so for a different mood give the character a second speaker entry with the same voice, like `dana-intercom`. Audition with `pnpm voices --play cartesia:Katie --say '<emotion value="scared"/>Please!'`.
- **Dana** (Part 3 on) is Cartesia's Katie. Her intercom lines use `dana-intercom` (same voice, `fx: radio`, `emotion: scared`).
- **The radio** uses the survivor's voice through a radio filter (`fx: radio`). It's the game's twist planted from episode 1. cast.yaml ties the two together with a YAML anchor, so changing his voice changes the radio's too.

## Setup, once

1. **Voices:** the survivor (and so the radio) is Cartesia's Tanner. Add `CARTESIA_API_KEY` to `.env`, then hear him:
   ```sh
   pnpm voices --play cartesia:Tanner --say "Better start cranking."
   ```
2. **Reference sheets:**
   ```sh
   pnpm render stories/hatch/sheets.yaml --images-only --no-check
   ```
   Look at `out/hatch-reference-sheets/contact-sheet.jpg`. Fix small things with `pnpm fix`, redo a sheet with `--regen <id>`, then copy the good ones from `out/hatch-reference-sheets/shots/` into `stories/hatch/refs/` and list them in cast.yaml:
   - `survivor` → `characters.you.refs`
   - `basement` → `locations.basement.refs` (and `props.hatch`, `props.crank`, since they're in it)
   - `props` → each prop's `refs`
   - `surface` → `locations.surface.refs`
   - `pets` → `characters.dog.refs` and `characters.cat.refs`
   - `living-room` → `locations.home.refs`; `yard` → `locations.yard.refs`

## Episodes

The overall direction is in `ARC.md`; vote results go in `VOTES.md`. Every episode gets the end card from cast.yaml (3 seconds, "play the game"); make its picture once with `endcard.yaml`.

- **Part 1, The Alert** (`ep01.yaml`): Saturday night at home with Milo and Zoey, the alert, the white sky, Milo goes down the hatch. Vote: go back for Zoey, or seal the hatch?
- **Part 2, Day One** (`ep02.yaml`): written for "seal it" (the game's canon). The first night below: the 6:14 broadcast, the crank, "Wonder if the cat got out," the grey "snow." Vote: open the hatch to a knock, or stay quiet?
- **Part 3, The Knock** (`ep03.yaml`): written for "stay quiet." The hooded knocker walks to the next house; Dana from across the street on the camera and intercom. Vote: let her stay, or send her back for her pantry first?

## Each episode

```sh
pnpm render stories/hatch/ep01.yaml --images-only   # review the contact sheet
pnpm fix stories/hatch/ep01.yaml knock "make the hatch square with a hinged lid"
pnpm keep stories/hatch/ep01.yaml all                # lock what you approve
pnpm render stories/hatch/ep01.yaml --draft         # cheap voices
pnpm render stories/hatch/ep01.yaml                 # final
```

Every episode ends on a vote, and the next one opens on the result ("Most of you said open it.").
