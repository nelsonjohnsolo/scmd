# Live Updates Specification

## Purpose

Keeps the review honest while Claude Code is running in another window by surfacing memories that appear or change mid-review.

## Requirements

### Requirement: New memory notice
When a memory file appears under a selected project during a review, the page SHALL show a notice naming it with the choices "Add to deck" and "Later".

#### Scenario: Add to deck
- **WHEN** a new memory appears and the user chooses "Add to deck"
- **THEN** the memory becomes the next card and the notice closes

#### Scenario: Later
- **WHEN** the user chooses "Later"
- **THEN** the notice closes, the deck is unchanged, and the memory appears as unreviewed on the next launch

### Requirement: Changed card reload
When the file behind a card that has not yet been decided changes, the page SHALL reload that card and show a brief notice that it was updated.

#### Scenario: Card updated mid-review
- **WHEN** the top card's file is modified externally
- **THEN** the card shows the new content and a notice says it was just updated

### Requirement: Removed card
When the file behind an undecided card disappears, the page SHALL remove the card and show a brief notice.

#### Scenario: File deleted externally
- **WHEN** a memory file in the deck is deleted outside SCMD
- **THEN** the card is removed from the deck with a notice, and any staged decision on it is dropped

### Requirement: Silent when nothing changes
No notice SHALL appear unless a memory file was added, changed, or removed.

#### Scenario: Quiet review
- **WHEN** no memory files change during a review
- **THEN** no update notices are shown

### Requirement: Own writes are not announced
Changes caused by SCMD's own apply SHALL not produce update notices.

#### Scenario: Apply
- **WHEN** the user applies decisions
- **THEN** the resulting file moves and edits produce no "updated" or "removed" notices
