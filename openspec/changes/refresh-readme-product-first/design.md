## Context

See `proposal.md` for motivation. The README is both the GitHub landing page and the document bundled into the npm package. Its current safety and launch guidance is accurate, but the first product proof is a placeholder. The existing README tests intentionally lock down commands, ordering, privacy claims, tone, and local-link integrity, so the redesign must update those checks rather than bypass them.

The visual comparison selected by the owner is direction A, "Product-first": restrained badges, a wide product preview, the Claude Code plugin launch path first, and a compact `Discover → Review → Confirm → Restore` journey. The approved SCMD visual system remains the source for the screenshot.

## Goals / Non-Goals

**Goals:**

- Make the product, primary launcher, and staged workflow understandable in the opening viewport.
- Use a real capture of the shipped UI with invented fixture data, not a marketing reconstruction or private memory.
- Keep the README portable across GitHub and npm and keep the screenshot available in the packed package.
- Preserve every existing command, platform caveat, read/write boundary, privacy claim, origin-story fact, and the no-exclamation-mark tone.
- Keep future maintenance limited to one screenshot and ordinary Markdown.

**Non-Goals:**

- Redesigning the product UI or adding README-only product claims.
- Introducing documentation generators, image-generation dependencies, or a large animated asset.
- Publishing the revised README to npm in this change; npm receives it with the next package version.

## Decisions

### D1. Product proof precedes setup detail

The README opening order will be: title and one-line promise, three badges, wide screenshot, primary Claude Code quick start, four-step workflow, then benefits and detailed setup. This puts the user's intended `/scmd:run` path first while retaining the isolated `npx` path below it.

Alternative considered: lead with requirements or privacy architecture. Both are useful later, but neither explains the product as quickly as the selected product-first direction.

### D2. Capture the real UI from invented fixtures

The screenshot will be captured from the real server and `index.html` using repository fixtures with invented project and memory names plus a temporary isolated `--state-dir`. It will show the review deck at a useful desktop width, with no browser chrome, local token, home directory, user identity, or real `~/.claude/projects` content visible. The final PNG will live at `docs/assets/scmd-review.png` and be checked for a valid PNG signature and useful dimensions. Its alt text will describe the visible review deck; the adjacent one-line promise and workflow will keep the README understandable if the image cannot load.

Alternative considered: copy the visual-companion mockup or generate a branded illustration. A real capture is more credible, stays aligned with the shipped UI, and avoids creating a second design surface.

### D3. Use portable Markdown with one absolute image target

The primary structure will use headings, fenced code, lists, and a small Markdown table only where it improves scanning. The screenshot will use an absolute raw GitHub URL so npm can render it independently of relative-link rewriting; the corresponding local asset will still be bundled so package consumers receive the complete documentation source. Badges may use standard HTTPS badge images, but no essential instruction will depend on them.

Alternative considered: GitHub-specific HTML layouts, Mermaid, and `<details>` as primary structure. They render inconsistently or hide important instructions on npm, so they will not carry essential content.

### D4. Package and test the documentation asset

`package.json#files` will include the public screenshot path without broadening the package to private handoff files. README and package-manifest tests will first be changed to express the selected hierarchy and exact new file list, then fail against the old README and manifest. After the README, screenshot, and manifest entry are added, targeted tests, the full `node --test` suite, `npm pack --dry-run`, and a tarball file-list check will verify the result.

Alternative considered: leave the screenshot out of the tarball because the npm page can fetch the raw GitHub URL. Bundling it makes the package self-contained and gives pack tests a direct guard against accidental omission.

### D5. Keep local agent workspaces private

`.superpowers/` and `.worktrees/` will be ignored. The comparison page and isolated implementation worktree are local agent workspaces, not public project content, and must not enter commits or npm packages.

## Risks / Trade-offs

- [The screenshot can drift from the UI] → Keep one real capture, use stable invented fixture content, and refresh it only when the visible deck changes materially.
- [The absolute image URL depends on GitHub availability] → Bundle the same PNG in the npm package and keep all essential explanation in text.
- [Badges add third-party requests when the README is viewed] → Use only three conventional badges and make them nonessential to understanding or verification.
- [Reordering can accidentally remove safety guidance] → Preserve explicit automated assertions for launch isolation, Windows behavior, read/write boundaries, privacy, and tone.
- [Adding `docs/` broadly could publish private handoff material] → Include only `docs/assets/scmd-review.png` in `package.json#files` and verify the exact tarball list.

## Migration Plan

1. Add the ignore rule and both README and package-manifest test expectations on a feature branch.
2. Capture and validate the fixture-backed screenshot.
3. Rewrite the README hierarchy and include only the public asset in the package manifest.
4. Run targeted tests, the full suite, strict OpenSpec validation, and package dry-run/file-list checks.
5. Review the rendered GitHub/npm-compatible Markdown locally before integrating; after integration, verify the absolute raw image URL resolves before publishing the next npm version.

Rollback is a normal revert of the documentation, asset, manifest entry, tests, and ignore rule. The already-published npm `0.1.0` remains unchanged; a later release will publish the revised README and asset.
