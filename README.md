# SCMD — Stop Calling Me Daddy

SCMD reviews Claude Code's persistent memories in a local deck so you can decide what stays before anything changes.

[![npm package](https://img.shields.io/npm/v/%40nelsonjohnsolo%2Fscmd?label=npm)](https://www.npmjs.com/package/@nelsonjohnsolo/scmd)
[![Node.js >=18](https://img.shields.io/badge/node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MIT license](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

![SCMD memory review deck with keep, delete, skip, and undo actions](https://raw.githubusercontent.com/nelsonjohnsolo/scmd/main/docs/assets/scmd-review.png)

This local review deck keeps decisions staged until you confirm changes.

## Quick start

### Claude Code plugin

The Claude Code plugin is the primary launcher. In Claude Code, add the marketplace and install SCMD:

```text
/plugin marketplace add nelsonjohnsolo/scmd
/plugin install scmd@scmd
/reload-plugins
/scmd:run
```

The plugin starts SCMD in the background, opens the review page, and reports its local URL in the session.

**Discover → Review → Confirm → Restore**

## What it does

- Shows memories under the default `~/.claude/projects` root as cards, oldest first, with project and memory details available for review.
- Filters by project or memory type and searches memory text, including read-only `CLAUDE.md` instructions.
- Lets you keep, delete, skip, or undo decisions without writing while you review.
- Applies the staged batch once you confirm it, moving deletes to restorable trash and refusing to overwrite a memory that changed after loading.
- Shows the session message that caused a memory when its origin can be found.
- Rewrites a memory through your local Claude Code CLI, or lets you edit it by hand, with the rewrite still staged until you apply it.
- Provides live updates as decisions and file state change, with zero dependencies at runtime.

## Requirements

Install Node.js 18 or newer, including `npm` and `npx`, before using either launch path.

On Windows, Git Bash is required for `/scmd:run` and the shell snippets below under the current best-effort support.

If you use a custom `CLAUDE_CONFIG_DIR` or auto-memory root, pass `--root <dir>` to either terminal command.

### Direct from a terminal

The recommended terminal path uses an isolated npm prefix, separate from SCMD's `~/.scmd` state, and asks npm for the current published release. Create the prefix once, then run SCMD:

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

## What it reads and writes

By default, SCMD reads `~/.claude/projects`, including memory files under `~/.claude/projects/*/memory/*.md` and each project's `MEMORY.md` index.

It reads project session `.jsonl` transcripts to resolve the real project path and answer “why was this saved?” when the origin can be found. It also searches global and project `CLAUDE.md` files, including `.claude/CLAUDE.md` and `CLAUDE.local.md`, as read-only results.

Review-decision writes happen only after you confirm Apply:

- `~/.scmd/reviewed.json` stores the content hashes you kept.
- `~/.scmd/trash/` stores deleted memories and restore metadata.
- An accepted edit writes the memory file and its matching `MEMORY.md` line; an accepted delete moves the memory file to `~/.scmd/trash/` and removes its matching `MEMORY.md` line.

Restore and Purge are separate explicit trash actions:

- Restore writes the memory file and its matching `MEMORY.md` line back.
- Purge permanently deletes the selected trash run.

Decisions stay staged in the browser until you confirm. Session transcripts and `CLAUDE.md` files are never modified.

## Privacy

The review server binds to `127.0.0.1`. Every API request carries a per-launch token. SCMD has no telemetry and sends nothing to an SCMD service.

If you request a rewrite, the rewrite text and your instruction go only through the local Claude Code CLI and its logged-in account. No rewrite text is sent anywhere by SCMD when you do not ask for one. Package installation and the Claude Code CLI may use the network according to their own configuration.

## Why

The owner's AI began calling him “daddy” at the start of every reply. His wife saw it. He did not know why. It was in Claude Code memory.

That is the general problem: Claude Code silently writes persistent memories and reads them back in later sessions. They accumulate, go stale, and preserve things you never meant to keep. SCMD turns cleanup into a short review: see every memory, make the calls, inspect the batch, then apply once.

## License

[MIT](LICENSE) © 2026 Nelson John
