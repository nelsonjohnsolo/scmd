# Review History Specification

## Purpose

Remembers which memories the user has already kept so that later launches only show what is new or changed, without writing anything into Claude Code's files.

## Requirements

### Requirement: Keep is recorded by content
Applying a keep SHALL record the memory's content hash and the time in SCMD's own state directory.

#### Scenario: Keep recorded
- **WHEN** the user applies a keep
- **THEN** a review record exists for that content and the memory file itself is byte-identical to before

### Requirement: Changed content resurfaces
A memory whose content differs from every recorded hash SHALL count as unreviewed.

#### Scenario: Claude edits a kept memory
- **WHEN** a kept memory's file is modified after the keep
- **THEN** on the next launch it appears in the default deck

### Requirement: Records survive file renames
Because records are keyed by content, a memory moved or renamed without content change SHALL remain reviewed.

#### Scenario: Same content, new name
- **WHEN** a kept memory file is renamed with identical content
- **THEN** it does not appear in the default deck

### Requirement: Corrupt or missing state is not fatal
If the review records cannot be read, the tool SHALL treat every memory as unreviewed and say so once on the page.

#### Scenario: Corrupt record file
- **WHEN** the review record file exists but is not valid
- **THEN** the page loads with all memories unreviewed and shows a one-line notice that the review history could not be read
