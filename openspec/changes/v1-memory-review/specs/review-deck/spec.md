## Purpose

Presents memories as a deck of cards that the user can filter, order, and search, so the next card is always the one most worth a decision.

## ADDED Requirements

### Requirement: Card contents
Each card SHALL show the memory's name, its summary as the headline, its type, its project, its date rendered as an age, and an expandable full body.

#### Scenario: Card display
- **WHEN** a card is on top of the deck
- **THEN** the name, summary, type badge, project chip, and age are visible without scrolling and the full body is one action away

### Requirement: Project filter
The user SHALL be able to limit the deck to any subset of projects; all projects are selected by default.

#### Scenario: Single project
- **WHEN** the user selects exactly one project
- **THEN** the deck contains only that project's memories and the count updates

### Requirement: Type filter
The user SHALL be able to limit the deck to any subset of memory types; all types are selected by default.

#### Scenario: Feedback only
- **WHEN** the user selects only the `feedback` type
- **THEN** the deck contains only cards of that type across the selected projects

### Requirement: Unreviewed by default
The deck SHALL show only memories with no review record by default, with a switch to show everything.

#### Scenario: Second launch
- **WHEN** the user launches after keeping twelve memories on a previous launch and Claude has added three since
- **THEN** the default deck contains the three new memories only

#### Scenario: Show everything
- **WHEN** the user switches to "everything"
- **THEN** all memories matching the other filters are in the deck, with kept ones marked as previously reviewed

### Requirement: Ordering
Within the current filters the deck SHALL present cards oldest first.

#### Scenario: Deck order
- **WHEN** the deck contains cards dated April, June, and September
- **THEN** the April card is on top

### Requirement: Cross-project search
A search box SHALL filter the deck to memories whose name, summary, or body contains the query, across all selected projects, as the user types.

#### Scenario: Search hit
- **WHEN** the user types a word that appears in the body of two memories in different projects
- **THEN** the deck contains exactly those two cards

### Requirement: Progress follows the current deck scope
Immediately above the card, the page SHALL show a non-sticky progress indicator whose denominator is every memory matching the current project, type, review-scope, and search filters and whose numerator is the matching memories with a staged keep or delete. The same area SHALL show session-wide staged keep and delete counts. Skip and edit SHALL not advance progress, undo SHALL reverse the corresponding progress, and special empty or instruction-search status messages SHALL remain visible when relevant.

#### Scenario: Decision and undo update progress
- **WHEN** the current filtered scope contains four memories and the user keeps one, deletes one, skips one, then undoes the delete
- **THEN** progress moves from 0 of 4 to 1 of 4 while the session-wide kept and deleted counts reflect the remaining staged decisions

#### Scenario: Filter recalculates progress
- **WHEN** the user has staged decisions in more than one project and then filters the deck to one project
- **THEN** the progress numerator and denominator describe only that project's matching memories while the staged kept and deleted counts still describe the whole session

### Requirement: Instruction-file hits are reported, not managed
When a search query matches text in a Claude Code instruction file (global or per project), the results SHALL include a read-only entry naming the file and line, stating that SCMD does not edit that file.

#### Scenario: Match in an instruction file
- **WHEN** the query matches a line in a project's `CLAUDE.md` and no memory
- **THEN** the results show one read-only entry with the file path and line number and no swipeable card

### Requirement: Empty states explain themselves
When the deck is empty the page SHALL say why in one sentence appropriate to the cause.

#### Scenario: Everything reviewed
- **WHEN** all memories under the current filters have review records and the switch is on "unreviewed"
- **THEN** the page says everything has been reviewed and offers the "everything" switch

#### Scenario: No memories at all
- **WHEN** the root contains no memory files
- **THEN** the page says no Claude Code memories were found and names the directory it looked in
