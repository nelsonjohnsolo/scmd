# SCMD — Stop Calling Me Daddy

SCMD reviews Claude Code's persistent memories as a fast, local deck: keep, delete, search, inspect origins, or rewrite them before anything changes.

## Requirements

Install Node.js 18 or newer, including `npm` and `npx`, before using either launch path.

On Windows, Git Bash is required for `/scmd:run` and the shell snippets below under the current best-effort support.

## Run it

### Claude Code plugin

Inside Claude Code, add the repository marketplace and install the plugin:

```text
/plugin marketplace add nelsonjohnsolo/scmd
/plugin install scmd@scmd
```

If Claude Code asks, run `/reload-plugins`. Then launch SCMD:

```text
/scmd:run
```

SCMD starts in the background, opens the review page, and reports its local URL in the session.

### Direct from a terminal

The recommended terminal path uses a private npm prefix, separate from SCMD's `~/.scmd` state, and asks npm for the current published release. Create the prefix once, then run SCMD:

```sh
mkdir -p "$HOME/.scmd-npx"
chmod 700 "$HOME/.scmd-npx"
npx -y --prefix="$HOME/.scmd-npx" --prefer-online @nelsonjohnsolo/scmd@latest
```

The shorter shorthand is fine from a trusted directory:

```sh
npx -y @nelsonjohnsolo/scmd
```

npm may resolve a matching project-local package when you use the shorthand. Do not use it in an untrusted project.

> Demo GIF: coming soon.

## What it does

- Shows memories under the default `~/.claude/projects` root as cards, oldest first.
- Filters by project or memory type and searches memory text plus read-only instruction files.
- Keeps, deletes, skips, and undoes decisions without writing until you apply them.
- Moves deletes to restorable trash and refuses to overwrite memories that changed after loading.
- Shows the session message that caused a memory when the origin can be found.
- Rewrites a memory through your local Claude Code CLI, or lets you edit it by hand.

If you use a custom `CLAUDE_CONFIG_DIR` or auto-memory root, pass `--root <dir>` to either terminal command.

## What it reads and writes

By default, SCMD reads:

- `~/.claude/projects/*/memory/*.md` and each project's `MEMORY.md` index.
- Project session `.jsonl` transcripts to resolve the real project path and answer “why was this saved?” on request.
- Global and project `CLAUDE.md` files for read-only search results, including `.claude/CLAUDE.md` and `CLAUDE.local.md`.

SCMD writes:

- `~/.scmd/reviewed.json` for the content hashes you kept.
- `~/.scmd/trash/` for deleted memories and restore metadata.
- A memory file and its matching `MEMORY.md` line only when you apply an accepted edit or delete.
- Restore writes the memory file and its matching `MEMORY.md` line back. Purge permanently deletes the selected trash run.

Decisions stay in the browser until you confirm. Session transcripts and `CLAUDE.md` files are never modified.

## Privacy

The review server binds to `127.0.0.1`, and every API request is protected by a per-launch token. SCMD has no telemetry and sends nothing to an SCMD service.

If you request a rewrite, the rewrite text and your instruction go only through the local Claude Code CLI and its logged-in account. No rewrite text is sent anywhere by SCMD when you do not ask for one. Package installation and the Claude Code CLI may use the network according to their own configuration.

## Why

The owner's AI began calling him “daddy” at the start of every reply. His wife saw it. He did not know why. It was in Claude Code memory.

That is the general problem: Claude Code silently writes persistent memories and reads them back in later sessions. They accumulate, go stale, and preserve things you never meant to keep. SCMD turns cleanup into a short review: see every memory, make the calls, inspect the batch, then apply once.

## License

[MIT](LICENSE) © 2026 Nelson John
