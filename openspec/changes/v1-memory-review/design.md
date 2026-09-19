## Context

See proposal.md — Why. Constraints that shape the approach:

- The data lives in the user's home directory in an undocumented, shifting format (three frontmatter variants observed in five months; folder names are a lossy encoding of the project path). The tool must degrade, never crash, on input it does not recognise.
- The tool is public and reads the user's home directory, so every dependency is attack surface and every line should be readable by a stranger in one sitting.
- A live Claude Code session may be writing to the same folders while the user is reviewing.
- The AI feature must use the user's existing Claude Code login; no API keys, no configuration.
- "One command, nothing to configure" is the product. Anything that adds a step for the user needs a strong reason.

## Goals / Non-Goals

**Goals:**
- Two files carry the whole product: `server.js` (Node, zero dependencies) and `index.html` (vanilla JS, no build).
- Every write to Claude's files is reversible, surgical, and guarded against concurrent modification.
- Behaviour is testable against fixture directories with Node's built-in test runner and no test dependencies.
- The frontend depends on a five-method `backend` interface so a File System Access backend could be added without touching UI code.

**Non-Goals (design level):**
- No persistence of UI state beyond the two sidecars (`reviewed.json`, trash manifests). Staged decisions live in the tab; closing the tab discards them.
- No markdown rendering engine. Bodies are shown as wrapped monospace text.
- No attempt to parse YAML generally. A tolerant reader for the handful of shapes Claude Code emits is enough and safer.

## Decisions

### D1. Single-file Node server, zero dependencies
`server.js` uses only `http`, `fs`, `path`, `crypto`, `child_process`, `readline`, `os`. The bin entry in `package.json` points at it, so `npx -y @nelsonjohnsolo/scmd` is a download of two files.
*Alternatives:* Express/Fastify (adds ~50 packages for routing we can write in 30 lines); Bun single executable (fast, but unsigned binaries trigger OS warnings and need CI for three platforms); Python stdlib server (zero-prerequisite on macOS/Linux, but the audience has Node and a JS repo is easier for contributors to the frontend).

### D2. Frontend talks to a five-method `backend`
`listProjects()`, `read(id)`, `write(id, text)`, `remove(id)`, `modifyWithAI(id, instruction)`, plus non-mutating helpers (`origin(id)`, `instructions()`, `events()`). The HTTP backend is the only implementation shipped. The interface is the seam for a later browser-only mode; it is also what makes the UI unit-testable with a fake backend.

### D3. Request authentication: URL token + Host check
The server generates 16 random bytes at start; the browser receives them in the URL and sends them back as a header on every request. Requests without a matching token, or with a `Host` other than `127.0.0.1`/`localhost`, get 401/403. This closes the two realistic local attacks: another tab on the machine calling the API (CSRF) and DNS rebinding. Binding to `127.0.0.1` only (never `0.0.0.0`) closes LAN exposure.
*Alternative:* cookie session — more code, same guarantee.

### D4. Card identity and content hash
A card's id is `<project-folder>/<file-name>` — stable across launches, opaque to the client, and never used as a path: the server resolves ids against the set it scanned, so a crafted id cannot escape the root. The content hash is SHA-256 of the file bytes. Both sidecars and the apply guard key on the hash.

### D5. Tolerant frontmatter reader, not a YAML parser
Reads the `---` block line by line. Recognises `key: value` at column 0 and `key: value` indented under `metadata:`. Resolution order: type ← `metadata.type` → `type` → filename prefix (`feedback_`, `project_`, `reference_`, `user_`) → `unknown`; date ← `metadata.modified` → file mtime; name ← `name` → filename stem; description ← `description` → first non-empty body line. A file with no frontmatter at all still yields a card. The reader is exercised by fixtures for every variant seen so far.
*Alternative:* a YAML dependency — general, but it is a parser for untrusted input in a tool that reads home directories, and the shapes are few.

### D6. Real project path from transcripts
For each project folder, read the newest `.jsonl` line by line until the first `"cwd"` field, cache it. Folders with no transcript keep their encoded name and a `pathUnknown` flag; the UI shows the folder name in that case and says the path could not be resolved. Two folders can never share a real path, but two real paths can collide on one folder name (Claude Code's own limitation); the newest transcript wins and the UI shows what it found.

### D7. Decisions are staged client-side and applied atomically per file
The client keeps `decisions: {id, action, expectedHash, newContent?}` and an undo stack. Apply sends the list once. For each item the server re-hashes the file; on mismatch it skips the item and reports `changed-since-read`. Deletes move the file to `~/.scmd/trash/<ISO-timestamp>/<project-folder>/<file>` and append `{id, from, indexLine, deletedAt}` to that run's `manifest.json`. Every write is temp-file-then-rename.
*Alternative:* apply per swipe — simpler state, but every mis-swipe becomes an immediate filesystem change.

### D8. `MEMORY.md` is edited by line, never regenerated
The index line for a memory is the line whose markdown link target equals the file name. Delete removes that line and nothing else. Edit replaces the text after the ` — ` separator with the new description when it changed, and appends a well-formed line when none exists. Restore re-inserts the line saved in the manifest, or appends one. Every other byte of the index is preserved so lines Claude wrote during the review are never lost.

### D9. Reviewed state is a hash-keyed sidecar
`~/.scmd/reviewed.json`: `{ "version": 1, "entries": { "<sha256>": { "at": "<ISO>", "id": "<card id>" } } }`. "Keep" adds an entry; the deck's default filter hides cards whose hash has an entry. A changed file has a new hash and resurfaces. Claude's files are never annotated. The file is small (one line per kept memory) and rewritten whole on each apply.

### D10. Rewrite via the local `claude` CLI, prompt on stdin
`claude -p --output-format json --model <fast>` with the memory file and the user's instruction on stdin; the prompt asks for the complete new file, frontmatter included, with `name`/`type` preserved and `description` updated only if needed to match. If the fast-model flag fails, retry once without it. 60-second timeout. `ENOENT` on spawn marks the capability unavailable for the session and the UI greys the box. The child is spawned with a copy of the environment that has Claude Code's nesting markers removed (`CLAUDECODE` and related), because when SCMD is launched from the plugin the server inherits a session environment and `claude` refuses to nest.
*Alternative:* the Agent SDK — a dependency and an API key; against the goals.

### D11. Origin lookup is by write action, streamed and bounded
Given `originSessionId`, open `<project-folder>/<id>.jsonl` (falling back to a search across project folders, because sessions can be resumed from another directory). Stream lines with `readline`; find the assistant tool call whose input path ends with the memory's file name; return the nearest preceding user message that is text (not a tool result). Files without `originSessionId` scan the project's newest twenty transcripts. Hard cap of 64 MB read per request and a 10-second budget; on either, return "not found" with a reason. Never loaded until the user asks.

### D12. Live updates over Server-Sent Events, which double as the heartbeat
The server watches every memory folder with `fs.watch`, debounces 300 ms, diffs `{file → hash}` snapshots, and pushes `added`/`changed`/`removed` events over one SSE connection the page opens on load. When no SSE client has been connected for 10 seconds the process exits — a page refresh reconnects well inside that window. If `fs.watch` throws (some Linux setups), fall back to polling the snapshot every 5 seconds. One mechanism, two jobs, no polling loop in the page.
*Alternative:* client polling — simpler on the server, but then the heartbeat is a second mechanism.

### D13. Instruction-file hits are read-only and client-side
On load the server returns the list and contents (capped at 256 KB each) of `~/.claude/CLAUDE.md` and, per resolved project, `CLAUDE.md`, `.claude/CLAUDE.md`, and `CLAUDE.local.md`. `@import` lines are not followed. The client searches these alongside memories and renders hits as non-swipeable results with file path and line number.

### D14. Launcher flags for testability
`--root <dir>` (default `~/.claude/projects`), `--state-dir <dir>` (default `~/.scmd`), `--port`, `--no-open`. Tests run the real server against `fixtures/` with a temporary state dir, using `node --test`. No mocking of the filesystem.

### D15. Plugin is a launcher, nothing more
`plugin/` holds a manifest and one command, `/scmd`, whose instruction is to run the scoped npm launcher (`npx -y @nelsonjohnsolo/scmd`) in the background and report the URL. The repository root carries the marketplace manifest so `/plugin marketplace add <owner>/scmd` works. The plugin contains no logic of its own; if the plugin format shifts, the tool is unaffected.

### D16. Visual system (approved 2026-09-19)
Sign-off artifact: https://claude.ai/artifact/6vecqURA1a6q1B7nHi4XDF. The page implements exactly this system; nothing else is introduced.

- **Palette (light):** paper `#FFFFFF`, ink `#121212`, muted `#6E6864`, soft surface `#F6F4F2`, red `#E5321E` (delete — the only loud accent), green `#1F9D55` (keep — semantic, quiet), marker `#FFE84D` (headline highlight only). Dark theme swaps paper/ink (`#101010` / `#F4F2EF`) and lifts red/green (`#FF5A45` / `#3FCB7A`); every colour is a CSS token on `:root`, redefined under `prefers-color-scheme: dark` and `[data-theme="dark"]`.
- **Type:** Bricolage Grotesque 800 for headlines and card names (Google Fonts, with a heavy sans fallback); the system sans stack for body; JetBrains Mono for commands, memory text, keycaps, and labels. One type scale; uppercase labels get letter-spacing.
- **Sticker cards:** 2px ink border, 18px radius, hard offset shadow `6px 6px 0 ink` (4px at phone width), no blur. Swipe tilts the card ±6° with a translate and shows a rubber-stamp DELETE (red, +12°) or KEEP (green, −12°). Two card edges peek behind the top card.
- **Controls:** pill buttons (2px border, 999px radius) — primary is ink on paper, outline, red for delete, green for keep, ghost for undo. Chips for filters (ink when on), mono uppercase badges for memory type, keycap glyphs for keyboard hints.
- **Deck layout, top to bottom:** top bar (wordmark, progress "n of m" with bar, kept/deleted counts, "Review & apply") → filters on the soft surface (projects, types, Unreviewed/Everything toggle, search) → one centred card, max 560px → action row (✗ Delete · ↑ Skip · ✓ Keep · Undo) → keyboard hints → rewrite box with the "uses your local Claude Code login" line → notices as a sticker toast beneath.
- **Tone:** blunt and short; at most one joke per screen; no exclamation marks; controls say what happens ("Apply 17 decisions").
- **Motion:** 180 ms tilt, 150 ms stamp; all disabled under `prefers-reduced-motion`.

### D17. Scoped npm identity, short executable and slash command
The public package is `@nelsonjohnsolo/scmd` because npm rejected the unscoped `scmd` name under its package-name similarity policy. The direct no-install command is `npx -y @nelsonjohnsolo/scmd`; the installed executable remains `scmd`, and the Claude Code command remains `/scmd`. Product copy leads with `/scmd` for the intended audience and presents the scoped `npx` command as the terminal alternative.
*Alternative:* choose a different unscoped npm name — rejected because it would change the product name without preserving the original short `npx -y scmd` command.

## Risks / Trade-offs

- [Memory format changes again] → tolerant reader with fallbacks for every field; fixtures pin each known variant; an unrecognised file becomes a card of type `unknown` rather than an error.
- [Claude writes between the apply-time hash check and the write] → the window is microseconds and the outcome is one lost Claude write, not corruption; documented, not engineered around.
- [`claude` refuses to run because SCMD was started inside a session] → spawn with nesting markers stripped; if it still fails, the UI shows the CLI's own error text and the hand editor remains available.
- [Transcripts of hundreds of MB] → streamed, capped, time-boxed; origin is lazy and optional.
- [`fs.watch` unreliable on some platforms] → polling fallback at 5 s; the feature degrades to "slightly delayed", never to "wrong".
- [Two projects encode to the same folder name] → inherent to Claude Code; the UI shows the resolved path so the user can tell.
- [Trash grows unbounded] → each apply run is one dated folder; a "Trash" screen lists runs with sizes and a purge button; nothing auto-purges.
- [User runs SCMD twice] → each instance has its own port and token; both work; the second sees the first's writes through the watcher.
- [Windows] → all paths go through `path` and `os.homedir()`; browser open uses `start`; untested in this change and stated as best-effort.

## Migration Plan

New tool; nothing to migrate. Rollback is `rm -rf ~/.scmd` after restoring anything wanted from trash; Claude's files carry no SCMD marks.

## Open Questions

- Whether to keep the index line's title in sync with `name` after a rewrite that changes `name`. Current design preserves the title and only updates the hook; can be revisited without changing specs.
- Exact plugin and marketplace manifest fields for the Claude Code version current at implementation time; verified during the plugin task against the docs.
- Whether to cap `reviewed.json` age (entries for files that no longer exist). Harmless today; can add pruning later.
