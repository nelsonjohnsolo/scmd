## 1. Scaffold and fixtures

- [ ] 1.1 Create `package.json` (name `scmd`, `bin` → `server.js`, `engines.node >= 18`, `files` limited to `server.js`, `index.html`, `plugin/`, `README.md`, `LICENSE`, no dependencies) and verify `npm pack --dry-run` lists exactly those files
- [ ] 1.2 Create `fixtures/projects/` with four project folders: (a) top-level `type:` variant, (b) nested `metadata:` variant, (c) no-frontmatter file plus a `feedback_`-prefixed file, (d) an empty `memory/` directory; include a `MEMORY.md` in (a) with one dangling line, and a session `.jsonl` in (a) containing a `cwd` field and a tool call that writes one of its memory files; verify `find fixtures -type f` shows every planned file
- [ ] 1.3 Add a `node --test` harness (`test/*.test.js`) with a helper that starts `server.js` against `fixtures/projects` and a temporary state directory on a free port and returns the URL and token; verify `npm test` runs one passing smoke test that fetches the page

## 2. Server core

- [ ] 2.1 Implement argument parsing (`--root`, `--state-dir`, `--port`, `--no-open`), the Node ≥ 18 check, and root-existence check; verify `node server.js --root /nope` exits non-zero with the path in the message and `node server.js --no-open` prints a `127.0.0.1` URL containing a token
- [ ] 2.2 Implement the HTTP server bound to `127.0.0.1` with token and Host checks, static serving of `index.html`, and the `/api/quit` route; verify with curl that a wrong token gets 401, a foreign Host gets 403, the correct token gets the page, and quit ends the process
- [ ] 2.3 Implement browser auto-open for macOS, Linux, and Windows and the SSE endpoint with the ten-second no-client exit; verify that opening the URL connects, refreshing keeps the process alive, and closing the tab ends it within ~10 s
- [ ] 2.4 Add tests for 2.1–2.3 to the harness; verify `npm test` passes

## 3. Memory discovery

- [ ] 3.1 Implement project enumeration and real-path resolution from the newest transcript's `cwd`, with the `pathUnknown` flag; verify `GET /api/projects` against fixtures returns four projects with counts 2/1/2/0 and against the real `~/.claude/projects` lists every project that has a `memory/` folder with its resolved path
- [ ] 3.2 Implement the tolerant frontmatter reader and card model (type/date/name/summary fallbacks, content hash, origin session id); verify unit tests cover all four fixture variants and that every real memory file on the machine yields a card with a non-empty name and summary
- [ ] 3.3 Implement `MEMORY.md` reading and the per-project report of unindexed files and dangling lines, and unreadable-file isolation; verify the fixture's dangling line is reported and that an unreadable file (chmod 000) is reported without failing the project
- [ ] 3.4 Verify discovery is read-only by running against a read-only copy of fixtures and confirming the page loads and no file is created under the root

## 4. Review history

- [ ] 4.1 Implement reading and atomic writing of `<state-dir>/reviewed.json` and the "unreviewed" computation; verify a unit test records a hash, a second scan hides that card by default, and a modified copy of the file reappears
- [ ] 4.2 Handle a corrupt `reviewed.json`; verify that writing garbage to it makes the page load with all cards unreviewed and a one-line notice

## 5. Apply, trash, and index maintenance

- [ ] 5.1 Implement `POST /api/apply` with per-item hash guard, keep → history record, and per-item results; verify a test that changes a file after read gets `changed-since-read` for that item while the other items succeed
- [ ] 5.2 Implement soft delete (move to `<state-dir>/trash/<timestamp>/<project>/<file>` + `manifest.json`) and the index-line removal that leaves every other byte intact; verify a test that appends a line to `MEMORY.md` after read, then deletes a different memory, still finds the appended line
- [ ] 5.3 Implement edit application (write new content, update or append the index hook when the description changed); verify a test where the description changes updates only that line's hook text
- [ ] 5.4 Implement `GET /api/trash` and `POST /api/restore` that put the file and its index line back; verify a delete-then-restore round trip leaves the memory folder and `MEMORY.md` byte-identical to the start
- [ ] 5.5 Verify failure isolation by making one target unwritable in a three-item apply and confirming two succeed and one reports the error
- [ ] 5.6 Run a real-world apply against a copy of `~/.claude/projects` (copied to a temp root): keep two, delete one, restore it; verify the copy matches the original afterwards

## 6. Review page: deck

- [ ] 6.1 Build the `index.html` shell with the five-method `backend` (HTTP implementation) plus `origin`, `instructions`, `events`, token bootstrap from the URL, and a fake backend for tests; verify the page loads against fixtures and shows the project list with counts
- [ ] 6.2 Implement card rendering (name, summary headline, type badge, project chip, age, expandable body); verify each fixture variant renders with all fields and the real memories render without layout breaks at 360 px and 1280 px widths
- [ ] 6.3 Implement project and type filters and the unreviewed/everything switch with oldest-first ordering; verify selecting one project and one type yields the expected fixture cards and the top card is the oldest
- [ ] 6.4 Implement search across name/summary/body and the read-only instruction-file hits (`~/.claude/CLAUDE.md`, per-project `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, capped at 256 KB each); verify a query that matches only a fixture `CLAUDE.md` shows a read-only entry with path and line and no card
- [ ] 6.5 Implement the empty states (all reviewed, no memories found, filter yields nothing); verify each message appears under its condition against fixtures

## 7. Review page: decisions

- [ ] 7.1 Implement keep/delete/skip via arrow keys and on-card buttons, the undo stack, and skip-to-end; verify keyboard and button paths stage the same decisions and undo restores the previous card
- [ ] 7.2 Implement pointer drag with threshold, tilt, and snap-back; verify a drag past the threshold stages the decision and a short drag snaps back with nothing staged
- [ ] 7.3 Implement the apply summary (counts, lists of deletes and edits, confirm) and the result screen with per-item outcomes; verify applying against fixtures shows correct counts and outcomes including a `changed-since-read` item
- [ ] 7.4 Implement the trash view (runs, sizes, restore, purge); verify a restore from the page produces the round trip in 5.4
- [ ] 7.5 Verify that closing the tab with staged decisions leaves the fixture root and state dir unchanged

## 8. Rewrite

- [ ] 8.1 Implement `POST /api/rewrite` spawning `claude -p --output-format json` with the prompt on stdin, fast-model-then-default retry, 60 s timeout, nesting-marker-stripped environment, `ENOENT` → capability off; verify with the real `claude` that "make this shorter" on a fixture memory returns a shorter valid memory file, and that `PATH=/usr/bin` makes `/api/status` report rewrite unavailable
- [ ] 8.2 Validate returned text as a memory file (frontmatter present, `name` and `type` preserved); verify a test with a deliberately malformed response reports "could not be used" and returns the raw text
- [ ] 8.3 Implement the rewrite field, the before/after line diff, accept/reject, the hand editor, the disabled state with explanation, and the "uses your local Claude Code login" line; verify accept stages an edit whose card shows the new summary, reject leaves the card unchanged, and the hand editor stages an edit without `claude`
- [ ] 8.4 Verify a rewrite from a tool launched inside a Claude Code session succeeds (nested-environment case)

## 9. Origin

- [ ] 9.1 Implement `GET /api/origin/:id` streaming the origin transcript, locating the write of the file, returning the preceding user message and date, with cross-folder fallback and the no-session-id fallback over the twenty newest transcripts, 64 MB / 10 s limits; verify the fixture transcript yields the planted user message, and a real memory on the machine yields the message that caused it
- [ ] 9.2 Implement the "why was this saved?" control that loads on demand and shows "not found" with a reason; verify no origin request is made until the control is used and that a fixture whose transcript lacks the write shows "not found"

## 10. Live updates

- [ ] 10.1 Implement the memory-folder watcher with 300 ms debounce, snapshot diff (`added`/`changed`/`removed`), SSE push, suppression of SCMD's own writes, and polling fallback when watching fails; verify creating, editing, and deleting a fixture file while the page is open produces exactly one event each and applying decisions produces none
- [ ] 10.2 Implement the notices: new memory → "Add to deck"/"Later"; changed undecided card → reload with notice; removed card → drop with notice; verify each against fixtures and that a quiet session shows no notices

## 11. Claude Code plugin

- [ ] 11.1 Create `plugin/` with the manifest and a `/scmd` command that starts the launcher in the background and reports the URL, plus the repository-root marketplace manifest, checked against the current plugin docs; verify installing from the local path makes `/scmd` available in a new session
- [ ] 11.2 Verify `/scmd` opens the review page against the real `~/.claude/projects` and that a rewrite from that instance works (8.4)

## 12. Packaging and release

- [ ] 12.1 Write `README.md` — one-line description, `npx -y scmd`, plugin install, a GIF placeholder, what it reads and writes, privacy statement, then the origin story as "Why" — and add an MIT `LICENSE`; verify the README renders on GitHub without broken sections
- [ ] 12.2 Run the full suite and a manual end-to-end pass against the real `~/.claude/projects` (not a copy): launch, filter, search, keep several, delete one, rewrite one, view an origin, apply, restore the delete, relaunch and confirm only unreviewed cards appear; verify each step matches its spec scenario
- [ ] 12.3 Publish `0.1.0` to npm and verify `npx -y scmd@0.1.0` starts from a machine or cache with no prior install
