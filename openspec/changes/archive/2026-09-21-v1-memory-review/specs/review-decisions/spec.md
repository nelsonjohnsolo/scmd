## Purpose

Lets the user decide each memory's fate quickly and safely: decisions are staged, reviewed together, applied surgically, and reversible.

## ADDED Requirements

### Requirement: Three decisions and undo
For the top card the user SHALL be able to keep or delete using the keyboard, on-card buttons, or a horizontal drag; SHALL be able to skip using the keyboard or on-card button; and SHALL be able to undo the most recent decisions in order.

#### Scenario: Keyboard keep
- **WHEN** the user presses the right arrow
- **THEN** the top card is staged as kept and the next card is on top

#### Scenario: Drag delete
- **WHEN** the user drags the top card past the left threshold and releases
- **THEN** the card is staged as deleted and the next card is on top

#### Scenario: Skip
- **WHEN** the user presses the up arrow
- **THEN** the card is set aside with no decision and reappears at the end of the deck

#### Scenario: Undo
- **WHEN** the user activates undo after staging a delete
- **THEN** that card returns to the top with no decision

### Requirement: Directional decision feedback
Every keep, delete, skip, and undo action SHALL provide directional card feedback before the deck advances, SHALL produce the same decision and motion semantics regardless of whether an available action came from pointer, keyboard, or button input, and SHALL prevent an in-progress transition from acting on another card.

#### Scenario: Committed pointer delete
- **WHEN** the user releases a predominantly horizontal drag beyond the left threshold
- **THEN** the DELETE stamp remains visible while that card continues left from its release position and exits before the delete is staged once and the next card becomes active

#### Scenario: Committed keep from keyboard or button
- **WHEN** the user keeps the centred card with the right arrow or Keep button
- **THEN** the card leans right with the KEEP stamp and completes the same rightward exit before the keep is staged once and the next card becomes active

#### Scenario: Short drag returns
- **WHEN** the user releases a drag below the decision threshold or cancels it
- **THEN** the card returns to its resting position and no decision is staged

#### Scenario: Skip feedback
- **WHEN** the user skips with the up arrow or Skip button
- **THEN** the card lifts and fades upward without a DELETE or KEEP stamp before moving once to the end of the deck

#### Scenario: Undo feedback
- **WHEN** the user undoes a keep, delete, or skip
- **THEN** the restored card re-enters from the direction associated with that prior action, settles on top without a decision stamp, and the prior state is reversed once

#### Scenario: Input during transition
- **WHEN** another pointer, keyboard, or decision-button input occurs while a card is exiting or re-entering
- **THEN** no second card is kept, deleted, skipped, or restored by that input

#### Scenario: Reduced motion
- **WHEN** the user prefers reduced motion and activates keep, delete, skip, or undo
- **THEN** the same state and focus update happens immediately without transform, fade, stamp animation, or an artificial wait

### Requirement: Nothing is written before apply
Staging decisions SHALL not modify any file.

#### Scenario: Close without applying
- **WHEN** the user stages decisions and closes the tab without applying
- **THEN** no memory file, index, or SCMD state file has changed

### Requirement: Apply summary
Before writing, the tool SHALL show counts of kept, deleted, and edited memories with the list of deletions and edits, and SHALL require explicit confirmation.

#### Scenario: Confirm
- **WHEN** the user confirms the summary
- **THEN** the decisions are applied and a result screen reports what was done per item

### Requirement: Soft delete with restore
A deleted memory SHALL be moved to SCMD's trash together with its index line, and SHALL be restorable from a trash view that lists past runs.

#### Scenario: Delete and restore
- **WHEN** the user applies a delete and then restores it from the trash view
- **THEN** the file is back at its original path with its original content and its index line is present again

### Requirement: Surgical index maintenance
Applying a delete SHALL remove only that memory's index line; applying an edit SHALL update only that memory's index line, adding one if none exists; all other index content SHALL be byte-identical afterwards.

#### Scenario: Index line added by Claude during review
- **WHEN** Claude appends a new index line while the user is reviewing and the user then applies a delete of a different memory
- **THEN** the new line is still present after apply

#### Scenario: Edit changes the summary
- **WHEN** an accepted edit changes the memory's description
- **THEN** the index line's hook text reflects the new description and the link target is unchanged

### Requirement: Changed-since-read guard
Apply SHALL compare each file's current content hash with the hash the card was read from and SHALL skip, with a per-item reason, any file that changed.

#### Scenario: Concurrent change
- **WHEN** a memory's file changed after the card was loaded and the user applies a delete of it
- **THEN** the file is not moved, the result screen marks it "changed since you saw it", and the refreshed card is offered for a new decision

### Requirement: Failure isolation
A failure applying one item SHALL not prevent the others from being applied, and the result screen SHALL state the outcome of every item.

#### Scenario: One unwritable file
- **WHEN** one of three deletes fails because the file is not writable
- **THEN** the other two are applied and the failed one is reported with the error
