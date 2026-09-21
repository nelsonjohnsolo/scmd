## Why

The shipped v0.1.0 README is accurate, but it still presents a "Demo GIF: coming soon" placeholder and makes readers work through setup detail before seeing the product. A product-first README will make SCMD understandable at a glance on both GitHub and npm while keeping its local, staged, reversible behavior clear.

## What Changes

- Lead with restrained npm, Node.js, and license badges plus a real SCMD product screenshot made from invented fixture data.
- Put the Claude Code plugin path and `/scmd:run` first as the primary quick start, followed by a compact `Discover → Review → Confirm → Restore` journey.
- Preserve the safe isolated terminal launch path, but move its rationale and platform detail below the primary path so it does not dominate the opening.
- Reorganize features, read/write boundaries, privacy, and the origin story into a more scannable hierarchy without weakening existing factual or safety claims.
- Update README tests so they verify the new hierarchy, local visual asset, commands, safety boundaries, tone, and npm package inclusion.

## Capabilities

### New Capabilities

None. This is a documentation-only change and `.openspec.yaml` opts out of delta specs.

### Modified Capabilities

None. Runtime behavior and existing product requirements do not change.

## Impact

- Updates `README.md`, `package.json`, `test/readme.test.js`, `test/package-manifest.test.js`, `.gitignore`, and one repository-owned screenshot under a documentation asset directory.
- The same README and image must be included by `npm pack`, so the published npm page can render the product-first presentation on the next package release.
- Adds no runtime, build, test, or documentation dependency.

## Non-goals

- Changing SCMD runtime behavior, UI behavior, plugin commands, CLI commands, privacy boundaries, or the approved visual system.
- Publishing another npm version, creating a Git tag or GitHub release, or changing package metadata as part of this change.
- Using private files from `~/.claude/projects`, the owner's other identities, or any real memory content in the screenshot.
- Adding a generated marketing illustration, large animated GIF, table of contents, or dependency-backed documentation tooling.
