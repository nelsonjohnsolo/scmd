# Local Server Specification

## Purpose

Starts SCMD with a single command, serves the review page only to the local user, and shuts itself down when the review is over.

## Requirements

### Requirement: Single-command launch
The tool SHALL start with one command and no configuration, print the URL of the review page, and open it in the user's default browser unless told not to.

#### Scenario: Default launch
- **WHEN** the user runs the launcher with no arguments
- **THEN** the tool starts, prints a URL on `127.0.0.1` with a random free port, and opens that URL in the default browser

#### Scenario: Launch without opening a browser
- **WHEN** the user runs the launcher with the no-open option
- **THEN** the tool starts and prints the URL but does not open a browser

#### Scenario: Node too old
- **WHEN** the launcher runs on a Node version below 18
- **THEN** it exits with a one-line message naming the minimum version and does not start a server

### Requirement: Local-only binding
The server SHALL listen only on the loopback interface and SHALL reject requests whose Host header is not a loopback host.

#### Scenario: LAN request
- **WHEN** a request arrives with a Host header other than `127.0.0.1` or `localhost`
- **THEN** the server responds 403 and performs no action

### Requirement: Per-launch token
Every launch SHALL generate a random token, include it in the printed URL, and require it on every API request.

#### Scenario: Request without token
- **WHEN** an API request arrives without the token or with a wrong token
- **THEN** the server responds 401 and performs no action

#### Scenario: Page bootstraps the token
- **WHEN** the review page is opened from the printed URL
- **THEN** the page sends the token on all subsequent API requests without further user action

### Requirement: Exit when the review ends
The server SHALL exit on its own once no review page has been connected for ten seconds, and SHALL exit immediately when the user chooses Quit in the page or interrupts it in the terminal.

#### Scenario: Tab closed
- **WHEN** the user closes the last review tab and does not reopen one within ten seconds
- **THEN** the process exits with status 0

#### Scenario: Page refresh
- **WHEN** the user refreshes the review page
- **THEN** the process keeps running and the refreshed page connects to it

#### Scenario: Quit from the page
- **WHEN** the user activates Quit in the page
- **THEN** the page shows a "closed" state and the process exits

### Requirement: Alternate roots for testing and advanced use
The launcher SHALL accept a root directory to scan in place of `~/.claude/projects` and a state directory in place of `~/.scmd`.

#### Scenario: Fixture root
- **WHEN** the launcher is started with a root that contains fixture project folders and a temporary state directory
- **THEN** the review page shows only the fixture projects and all SCMD state is written under the temporary directory

#### Scenario: Root does not exist
- **WHEN** the given root directory does not exist
- **THEN** the launcher exits with a message naming the path and does not start a server

### Requirement: No outbound network access
The tool SHALL make no network requests other than serving the local page.

#### Scenario: Offline use
- **WHEN** the machine has no network connectivity
- **THEN** every feature except AI rewrite works unchanged
