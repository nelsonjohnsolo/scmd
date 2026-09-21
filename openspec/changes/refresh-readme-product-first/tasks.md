## 1. Lock the Product-First Contract

- [x] 1.1 Update `test/readme.test.js` first to require the selected opening hierarchy (title and promise, npm/Node/MIT badges, product screenshot, Claude plugin quick start, `Discover → Review → Confirm → Restore`) while preserving all existing command, privacy, read/write, origin-story, and tone assertions; run `node --test test/readme.test.js` and verify it fails only because the old README lacks the new structure.
- [x] 1.2 Update `test/package-manifest.test.js` first to require only `docs/assets/scmd-review.png` as the new public package file and to reject private handoff, brainstorming, fixture, test, and OpenSpec paths; run `node --test test/package-manifest.test.js` and verify it fails because the screenshot and manifest entry do not exist yet.
- [x] 1.3 Add `.superpowers/` and `.worktrees/` to `.gitignore` and verify `git check-ignore -v --no-index .superpowers/ .worktrees/` succeeds from `.gitignore` while `git status --short` still shows the OpenSpec change but no brainstorming or nested-worktree files.

## 2. Capture Real Product Proof

- [x] 2.1 Launch the real server with `--root fixtures/projects --state-dir <temporary-directory> --no-open`, capture a wide content-only review-deck screenshot to `docs/assets/scmd-review.png`, remove the temporary state directory, and verify visually plus with PNG signature/dimension checks that it shows the shipped UI without browser chrome, token, home path, private identity, or real `~/.claude/projects` content.

## 3. Restructure and Package the README

- [x] 3.1 Rewrite `README.md` in the approved product-first order, remove the demo placeholder, add descriptive screenshot alt text plus sufficient adjacent text for image failure, keep the plugin path primary and isolated terminal path secondary, preserve every tested safety boundary and the origin story, then run `node --test test/readme.test.js` and verify all README tests pass.
- [x] 3.2 Add only `docs/assets/scmd-review.png` to `package.json#files`; run `npm pack --dry-run --json` and verify the exact public file list includes the README and screenshot but excludes `docs/handoff/`, `.superpowers/`, tests, fixtures, and OpenSpec artifacts.

## 4. End-to-End Verification

- [x] 4.1 Run the full `npm test` suite and `openspec validate refresh-readme-product-first --strict`; verify a fixture-backed launch with an isolated temporary state directory, inspect the packed README and image, confirm the packed README matches the repository README byte-for-byte and contains the exact absolute image URL, then perform the required final read-only smoke launch against the owner's real default `~/.claude/projects` root with another temporary `--state-dir` and `--no-open`, inspecting only UI structure and documented behavior without capturing card content, staging decisions, or applying changes.
