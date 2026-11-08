# Agent guide

## Git conventions

Commits follow [Conventional Commits 1.0](https://www.conventionalcommits.org/en/v1.0.0/).

### Header

`type(scope): description`

- **type**: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `build`, `ci`, `style`, `revert`
- **scope** (optional): the one area the commit touches
  - Engine: `env`, `util`, `ffmpeg`, `schema`, `load`, `gemini`, `images`, `speech`, `timeline`, `captions`, `video`, `render`, `cli`
  - Content: `stories` (shared or sample stories), or the show name, such as `hatch`
  - App: `studio`, or `studio-server` / `studio-web` when the change is limited to one side
- **description**: imperative mood, lowercase first word, no trailing period
- Header at most 72 characters
- Breaking change: `!` after the type or scope, plus a `BREAKING CHANGE:` footer

### Body

- Wrap at 72 columns, with a blank line after the header
- Explain what changed and why, not how. Each body stands on its own.
- Optional for trivial commits (for example, `feat(hatch): add episode 12`)

### Scope of a commit

- One concern per commit. If the subject needs "and", split it.
- Keep the build working at every commit where possible.
- No ticket references.

### Never include

- `Co-Authored-By`, "Generated with ..." or other tool or AI attribution lines
- Process commentary ("split from previous commit", "addressing review")
- `.env`, media files (images, audio, video), `out/`, `.cache/`, `.studio/`
