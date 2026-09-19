## Why

Claude Code silently writes persistent memories while you work — one file per fact, per project — and reads them back at the start of every later session. They accumulate across every project you touch, go stale, and occasionally capture something you never meant to keep. There is no built-in way to see them all, let alone prune them; the only options today are hand-editing hidden folders or installing heavyweight dashboards.

SCMD is a one-command local tool that turns this into a two-minute habit: every memory becomes a card, you keep or delete with a swipe or a keystroke, and nothing is written until you have reviewed your decisions.

## What Changes

- **New: local launcher.** `npx -y scmd` starts a zero-dependency Node server bound to `127.0.0.1` on a random port with a one-time URL token, opens the browser, and exits on its own when the tab closes. A `--root <dir>` flag points it at a directory other than `~/.claude/projects` (used for testing against fixtures).
- **New: memory discovery.** Scans `~/.claude/projects/*/memory/*.md`, resolves each project's real path from the `cwd` field of its session transcripts (folder names are lossy and are never decoded), and parses every frontmatter variant Claude Code has produced so far. Projects with an empty memory folder are listed with a zero count rather than hidden.
- **New: review deck.** Cards show the memory's name, its existing `description` as the plain-English summary, type, project, age, and an expandable body. The deck is filterable by project and by type, defaults to *unreviewed only* with a toggle for *everything*, orders oldest-first, and has a cross-project search box. Search also reports read-only hits in `CLAUDE.md` files (global and per project) so a user hunting for an instruction is told where it lives even when SCMD cannot edit it.
- **New: decisions.** Keep (→ / ✓), delete (← / ✗), skip (↑), undo. Decisions are staged, then applied from a summary screen. Deletes move the file to `~/.scmd/trash/` with a manifest for one-click restore and remove only that memory's line from `MEMORY.md`, leaving every other byte of the index untouched. Apply refuses to write any file whose content hash changed since it was read.
- **New: review history.** "Keep" records the memory's content hash in `~/.scmd/reviewed.json`. Nothing is written into Claude's files. A memory whose content later changes resurfaces automatically.
- **New: rewrite.** A text box under each card sends the memory plus the user's instruction to the local `claude -p` (user's own login; fast model first, silent fallback to default). The result is shown as a before/after diff and only becomes a staged edit when accepted; if the `description` changed, the index line is updated on apply. A plain "edit by hand" editor is always available, and the AI box degrades gracefully when `claude` is not installed.
- **New: origin.** A "why was this saved?" control on each card locates, in the originating session transcript, the tool call that wrote the file and shows the user message that preceded it. Loaded lazily, on demand.
- **New: live updates.** The server watches the memory folders; when Claude adds or changes a memory during a review, the page shows a small notice with *Add to deck* / *Later* (for new files) or reloads the affected card (for changed files). Silent when nothing changes.
- **New: Claude Code plugin.** A thin plugin exposing `/scmd`, which runs the same launcher from inside a session.

## Capabilities

### New Capabilities

- `local-server`: process lifecycle, localhost binding and token, browser auto-open, tab-close exit, `--root` override, and the HTTP interface `index.html` talks to.
- `memory-discovery`: locating projects and memory files, resolving real project paths, and parsing every known frontmatter variant into one card model.
- `review-deck`: card contents, project and type filters, unreviewed/everything toggle, ordering, and search including read-only `CLAUDE.md` hits.
- `review-decisions`: keep / delete / skip / undo, staged decisions, the apply summary, soft delete and restore, `MEMORY.md` index maintenance, and the changed-since-read guard.
- `review-history`: the hash-keyed sidecar that makes "keep" durable across launches without touching Claude's files.
- `memory-rewrite`: AI-assisted rewrite through the local `claude` CLI, the diff-and-accept flow, the hand-edit fallback, and behaviour when `claude` is unavailable.
- `memory-origin`: finding and presenting the session moment that produced a memory.
- `live-updates`: watching memory folders and surfacing new or changed memories during a review.
- `claude-code-plugin`: the `/scmd` launcher plugin and its install path.

### Modified Capabilities

None — this is the first change in the project.

## Non-goals

- **Other agents.** Codex, Cursor, Gemini CLI and any other tool's memory are out of scope. The source layer is written so an adapter could be added, but no adapter ships and no cross-agent feature is designed.
- **Editing `CLAUDE.md`.** SCMD only *reports* search hits in instruction files; it never modifies them.
- **Session transcripts.** SCMD reads transcripts (for real project paths and the origin feature) but never lists, edits, or deletes them.
- **AI-generated summaries at launch.** The `description` Claude already wrote is the summary. No model call happens unless the user asks for a rewrite.
- **Adding fields to Claude's memory files.** All SCMD state lives in `~/.scmd/`. Claude's files are only ever kept verbatim, replaced wholesale with an accepted rewrite, or moved to trash.
- **Any network access.** No telemetry, no update checks, no remote AI. The only process SCMD talks to is the user's local `claude` binary, and only on explicit request.
- **A pure-browser (File System Access API) mode.** Kept possible by the `backend` interface; not built in this change.
- **Multi-user or team features.** Single machine, single user, single `~/.claude`.

## Impact

- **New repository contents:** `server.js`, `index.html`, `package.json` (with a `bin` entry), a `plugin/` directory for the Claude Code plugin, a `fixtures/` directory with sample `~/.claude/projects` trees covering every frontmatter variant, and a README that leads with what the tool does and keeps the origin story as a "Why" section.
- **Runtime requirements:** Node 18+ (built-in `http`, `fs`, `path`, `crypto`, `child_process` only). `claude` on `PATH` is optional and only enables the rewrite feature. Developed on macOS, expected to work on Linux; Windows is best-effort in this change.
- **Dependencies:** none at runtime and none at build time — there is no build step. This is deliberate: it keeps `npx` start-up fast, makes the whole tool readable in one sitting, and removes supply-chain surface from a program that reads the user's home directory.
- **Files SCMD writes:** `~/.scmd/reviewed.json`, `~/.scmd/trash/**`, and — only on apply — the specific memory files and `MEMORY.md` lines the user decided on.
- **Public surface:** the npm package name `scmd` (available as of 2026-09-17) and the plugin name `scmd`. Both are claimed by this change.
