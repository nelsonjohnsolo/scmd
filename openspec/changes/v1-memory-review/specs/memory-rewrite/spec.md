## Purpose

Lets the user reshape a memory in plain language using their own local Claude, or by hand, with a diff to review before anything is staged.

## ADDED Requirements

### Requirement: Rewrite with an instruction
Each card SHALL offer a text field for a rewrite instruction; submitting it SHALL produce a proposed new version of the whole memory file with its name and type preserved and its description updated only if needed to match the new content.

#### Scenario: Shorten
- **WHEN** the user submits "make this shorter"
- **THEN** a proposed version appears that is a valid memory file with the same name and type

### Requirement: Uses the user's own Claude Code login
The rewrite SHALL be performed by the locally installed Claude Code command line using its existing authentication, and the page SHALL say so beneath the field.

#### Scenario: No API key needed
- **WHEN** the user has Claude Code installed and logged in
- **THEN** rewrites work with no additional configuration

### Requirement: Diff before staging
The proposed version SHALL be shown as a before/after comparison; it SHALL become a staged edit only when the user accepts it.

#### Scenario: Reject
- **WHEN** the user rejects the proposal
- **THEN** the card is unchanged and nothing is staged

#### Scenario: Accept
- **WHEN** the user accepts the proposal
- **THEN** an edit decision is staged for that card and the card shows the new summary

### Requirement: Hand editing is always available
Each card SHALL offer a plain editor for the full memory file, independent of AI availability, that stages an edit on save.

#### Scenario: Manual fix
- **WHEN** the user opens the editor, changes one line, and saves
- **THEN** an edit decision is staged with the modified content

### Requirement: Graceful absence of Claude Code
When the Claude Code command is not installed, the rewrite field SHALL be disabled with a one-line explanation and the hand editor SHALL remain available.

#### Scenario: Not installed
- **WHEN** the Claude Code command cannot be found
- **THEN** the field is disabled with the text explaining that installing Claude Code enables rewrites

### Requirement: Failure reporting
When a rewrite fails or times out, the page SHALL show the reason and leave the card unchanged.

#### Scenario: Timeout
- **WHEN** the rewrite does not complete within the time limit
- **THEN** the page reports a timeout, the field is re-enabled, and no edit is staged

#### Scenario: Invalid proposal
- **WHEN** the returned text is not a valid memory file
- **THEN** the page says the proposal could not be used and offers the hand editor with the returned text pre-filled
