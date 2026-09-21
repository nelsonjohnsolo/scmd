# Memory Discovery Specification

## Purpose

Finds every Claude Code memory on the machine, works out which real project it belongs to, and reads it into one consistent card shape regardless of which file format Claude Code used to write it.

## Requirements

### Requirement: Project enumeration
The tool SHALL list every project folder under the root that has a memory directory, including folders whose memory directory is empty, with the number of memories in each.

#### Scenario: Mixed projects
- **WHEN** the root contains one folder with five memories, one with an empty memory directory, and one with no memory directory
- **THEN** the project list shows the first with count 5, the second with count 0, and omits the third

### Requirement: Real project path resolution
For each project folder the tool SHALL determine the real project path from the folder's session transcripts and SHALL never derive it from the folder name.

#### Scenario: Transcript available
- **WHEN** a project folder contains at least one session transcript that records a working directory
- **THEN** the project is displayed by that directory's name and the full path is available on the card

#### Scenario: No transcript
- **WHEN** a project folder contains no session transcript
- **THEN** the project is displayed by its folder name with an explicit "path unknown" indication

### Requirement: Card model from any known frontmatter variant
Each memory file SHALL yield a card with name, summary, type, date, project, full body, and a content hash, using these fallbacks: type from nested metadata, then top-level, then filename prefix, then `unknown`; date from nested metadata, then file modification time; name from frontmatter, then filename; summary from `description`, then the first non-empty body line.

#### Scenario: Top-level type variant
- **WHEN** a memory file has top-level `type:` and `originSessionId:` keys
- **THEN** the card's type is that value and the origin session id is available to other features

#### Scenario: Nested metadata variant
- **WHEN** a memory file nests `type`, `originSessionId`, and `modified` under `metadata:`
- **THEN** the card's type, origin session id, and date come from those nested values

#### Scenario: Filename-prefix fallback
- **WHEN** a memory file has no type in its frontmatter and its name starts with `feedback_`
- **THEN** the card's type is `feedback`

#### Scenario: No frontmatter at all
- **WHEN** a memory file contains no frontmatter block
- **THEN** it still yields a card, with name from the filename, summary from the first non-empty line, and type `unknown`

#### Scenario: Unreadable file
- **WHEN** a memory file cannot be read or decoded
- **THEN** the project still loads, the file is reported as unreadable in the project's summary, and no card is produced for it

### Requirement: Index awareness
The tool SHALL read each project's `MEMORY.md` index and SHALL report, per project, any memory file with no index line and any index line whose file does not exist.

#### Scenario: Orphaned index line
- **WHEN** the index contains a line linking to a file that is not present
- **THEN** the project summary lists that line as dangling and no card is created for it

### Requirement: Discovery never mutates
Discovery SHALL open every file read-only and SHALL create no files under the root.

#### Scenario: Read-only root
- **WHEN** the root directory is not writable
- **THEN** discovery completes and the review page loads normally
