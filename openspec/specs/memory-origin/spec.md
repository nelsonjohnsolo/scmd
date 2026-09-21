# Memory Origin Specification

## Purpose

Shows the moment in a past session that caused a memory to be written, so the user can judge whether it should have been.

## Requirements

### Requirement: On-demand origin lookup
Each card SHALL offer a "why was this saved?" action that, when activated, finds the session in which the memory file was written and shows the user's message immediately preceding the write, with the session date.

#### Scenario: Origin found
- **WHEN** the memory records its origin session and that session's transcript contains the write of the file
- **THEN** the card shows the preceding user message and the session date

#### Scenario: Session resumed elsewhere
- **WHEN** the origin session's transcript is stored under a different project folder
- **THEN** it is still found and the origin is shown

### Requirement: Fallback without a recorded session
When a memory has no recorded origin session, the tool SHALL look for the write in the project's most recent transcripts.

#### Scenario: Old-format memory
- **WHEN** a memory has no origin session id and the write appears in one of the project's recent transcripts
- **THEN** the origin is shown from that transcript

### Requirement: Bounded and lazy
The lookup SHALL not run until requested, SHALL limit how much transcript data it reads and how long it runs, and SHALL report "not found" with a reason when the limits are reached.

#### Scenario: Very large transcript
- **WHEN** the transcript exceeds the read limit before the write is found
- **THEN** the card shows "not found" with the reason that the transcript was too large

### Requirement: Read-only
Origin lookup SHALL never modify a transcript.

#### Scenario: Read-only transcripts
- **WHEN** transcripts are not writable
- **THEN** origin lookup works unchanged
