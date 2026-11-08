# story-pipeline

Write a scene in YAML, get a narrated vertical video: consistent characters (Gemini images + reference sheets), consistent voices (ElevenLabs), slow camera moves, crossfades, sound effects and burned-in captions.

```
ep01.yaml ─► images (Gemini + refs + check) ─► voices (ElevenLabs) ─► timing ─► sfx ─► ffmpeg ─► mp4
```

## Setup

```sh
nvm use                      # Node 24 (anything ≥ 22.18 works)
pnpm install
brew install ffmpeg-full     # plain `ffmpeg` lacks libass, which captions need; this is found automatically
cp .env.example .env         # paste your keys (CARTESIA_API_KEY only if you use Cartesia voices)
pnpm preflight stories/bunker/ep01.yaml
```

Then choose voices and paste their ids into `stories/bunker/cast.yaml` (the brothers are `SET_ME`):

```sh
pnpm voices
pnpm voices --search child
pnpm voices --play <id>                          # free preview sample
pnpm voices --play <id> --say "Stay here."       # hear your own line (a few credits, cached)
```

Voices can come from ElevenLabs or Cartesia, mixed freely in one cast. A bare id is an ElevenLabs voice; `cartesia:Tanner` (a name or an id) is a Cartesia voice and needs `CARTESIA_API_KEY` in `.env`. Names are looked up once and remembered.

```sh
pnpm voices --cartesia --search tanner
pnpm voices --play cartesia:Tanner --say "Better start cranking."
```

Per-voice `settings` in cast.yaml: ElevenLabs uses `stability`, `similarity_boost`, `style` and `speed`; Cartesia uses `speed` (0.6 to 1.5), `volume` and `emotion` (e.g. `calm`, `sad`, `scared`). Each ignores the other's.

The ElevenLabs API can only use voices in your account. Add voices from the Voice Library on the website first if you want more choices.

## Making an episode

```sh
pnpm render stories/bunker/ep01.yaml --mock          # free: placeholder pictures and tones, checks timing
pnpm render stories/bunker/ep01.yaml --images-only   # images + contact sheet, no audio spend
pnpm fix stories/bunker/ep01.yaml knock "remove the extra hand"        # change one thing, keep the rest
pnpm render stories/bunker/ep01.yaml --regen knock,vote --images-only   # redraw shots from scratch
pnpm keep stories/bunker/ep01.yaml all                                   # lock the images you approve
pnpm render stories/bunker/ep01.yaml --draft         # cheap voices, same images
pnpm render stories/bunker/ep01.yaml                 # final
```

Output goes to `out/<title>/`:

- `<title>.mp4`: the video (`-draft` / `-mock` suffix for those modes)
- `contact-sheet.jpg`: every shot at a glance
- `shots/`: each shot's image
- `report.md`: timing per shot, what was generated, and any shot the checker still flagged

Everything is cached in `.cache/` by its inputs. Re-running only pays for what changed: edit one line and only that line is re-voiced; edit one image prompt and only that image is redrawn. Delete `.cache/` to start clean.

## How consistency works

- **cast.yaml** holds the style prompt, each character's description, voice and reference images, plus locations and props. Every prompt starts with the style, and each shot sends the reference images of everything in it.
- **The check**: after each image, a Gemini vision model compares it with the references and the shot description. It only fails what a viewer would notice in two seconds on a phone (off-model character, wrong prop shape, broken anatomy, impossible staging), and then edits the image to fix just that. Two attempts at most (`IMAGE_MAX_ATTEMPTS`); the attempt with the fewest problems is kept, and anything still wrong is flagged in `report.md`. `--no-check` skips it.
- **Layouts drift without plates.** References say what things look like, not where they are. For a recurring set, describe the layout in its cast.yaml description and use `plate:` for shots where position matters.
- **Left and right:** image models can't reliably put things on a particular side, so don't make a feature depend on it ("an armband on one sleeve", not "on his left sleeve").
- **`pnpm keep`** locks images you've approved (copied from the last render into `<story>/kept/<episode>/`). After that, editing prompts or cast.yaml won't redraw them; `--regen <id>` will, and unlocks it.
- **`pnpm fix`** does the same edit with your own instruction, for anything the checker missed.
- **One distinctive feature per character** (a colored armband, cap or scarf) makes them recognizable at phone size and gives the checker something concrete to verify.
- **Voices** are fixed per character in cast.yaml, so every line from a character uses the same voice and settings.

Tip: when a generated image nails a character, location or prop, copy it from `out/.../shots/` into `refs/` and add it to that entry's `refs`. More good references give more consistent results.

## Writing scenes

See the comments at the top of `stories/bunker/ep01.yaml`, and `stories/hatch/` for a full series setup. In short, each shot has an `image` prompt, the `location`/`cast`/`props` in it, a camera `move`, and `lines` like `- older: "Stay here."`. Wrap a word in `*stars*` to color it in the captions. A shot lasts as long as its lines, or `hold` seconds; aim for a new picture every 2 to 4 seconds.

Also available:

- `plate: refs/basement.jpg` on a shot (with `plate_focus: [x, y]` and `plate_zoom`): edits the shot into a 9:16 window of that image instead of drawing the room from scratch, so furniture can't move between shots. Best for shots of a known set; leave it off for wide shots and face close-ups.
- `references: false` on a shot: send no reference images (used by `sheets.yaml`, which makes the references).
- `end_card:` in cast.yaml (`image`, `text`, `seconds`): a still frame after every episode with text over it, e.g. where to play the game. An episode can override it, or turn it off with `end_card: false`.
- `header: "HATCH · PART 1"` on the scene: shown at the top for the whole video, so episodes read as a series.
- `transition:` per shot: `cut` (default), `fade` or `fadeblack`. Save fades for time passing or big reveals.
- `fx: radio` on a character in cast.yaml: their lines sound like a broadcast, intercom or tape.
- `music:` and `music_volume:` on the scene: looped under the video, ducked automatically while anyone speaks.
- Sound effects dip a little (about 10 to 15 dB) while anyone speaks, so a loud `sfx` never buries a line. `sfx_volume` sets how loud it is the rest of the time.
- Each line is voiced knowing the same speaker's previous and next line, so delivery flows across shots.

## Costs (rough)

- Images: about $0.08 each with `gemini-3.1-flash-image-preview`, plus retries when the check fails. A 7-shot episode is about $0.60–1.20.
- Voices: about 1 ElevenLabs credit per character (half with `--draft`). The sample episode is about 300 characters. Cartesia lines use Cartesia credits instead.
- Sound effects use ElevenLabs credits too, rounded up to whole seconds per shot.
- Runs that would generate more than 25 images stop and ask for `--yes`.

Before publishing, note that the ElevenLabs Free plan has no commercial license (Starter and up do).

## Notes

- Models are set in `.env`. `pnpm preflight` lists the image models your key can use if the defaults change.
- The sample `refs/brothers-sheet.jpg` draws the younger brother with a pale body, while `bunker-brothers.jpg` and cast.yaml give him a black stick body. Regenerate the sheet to match, or the checker will keep flagging him.
