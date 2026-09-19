## Purpose

Lets a user start SCMD from inside a Claude Code session with one slash command, without leaving the terminal they are already in.

## ADDED Requirements

### Requirement: Installable from the repository
The plugin SHALL be installable through Claude Code's plugin mechanism directly from the project's public repository.

#### Scenario: Install
- **WHEN** the user adds the repository as a plugin source and installs `scmd`
- **THEN** the `/scmd` command is available in subsequent sessions

### Requirement: `/scmd` launches the tool
The `/scmd` command SHALL start the launcher without blocking the session and report the review URL.

#### Scenario: Launch from a session
- **WHEN** the user runs `/scmd`
- **THEN** the tool starts in the background, the session reports the URL, and the browser opens the review page

### Requirement: AI rewrite works when launched from a session
A tool started by `/scmd` SHALL still be able to perform AI rewrites.

#### Scenario: Nested launch
- **WHEN** the tool was started from inside a Claude Code session and the user requests a rewrite
- **THEN** the rewrite completes as it would from a plain terminal

### Requirement: The plugin carries no product logic
The plugin SHALL only start the launcher; all behaviour SHALL come from the tool itself.

#### Scenario: Tool updated independently
- **WHEN** the tool is updated without updating the plugin
- **THEN** `/scmd` starts the updated tool
