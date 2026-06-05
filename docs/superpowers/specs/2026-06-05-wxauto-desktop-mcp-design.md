# wxauto Desktop MCP App Design

## Context

The current WeChat integration is a three-process bridge:

1. `scripts/wxauto-local-rest.py` or an external wxauto REST service controls the locally logged-in Windows WeChat client.
2. `scripts/wxauto-rest-bridge.mjs` polls wxauto, posts inbound events to the board, claims outbound messages, and reports send results.
3. The Next.js board owns identity registration, follow-up questions, ticket creation, deduplication, escalation, and outbound message generation.

The goal is to replace the transport-side scripts with a separately installed Windows desktop application named `wxauto-desktop`. It must provide a complete graphical operations console and connect to the public board through the standard Model Context Protocol.

The desktop application and the board are separate products and release units:

- `wxauto-desktop` is maintained in its own repository.
- This repository adds the public MCP server, update distribution endpoints, and temporary compatibility support for the existing HTTP bridge.

## Product Decisions

- Platform: Windows 10 and Windows 11, x64 only.
- Desktop stack: Electron, React, and an embedded Python wxauto worker.
- Account scope: one Windows computer and one logged-in WeChat account.
- The installer does not include WeChat. It detects the user-installed official WeChat process and login state.
- The app starts with Windows and remains running in the system tray when the main window closes.
- The board is the MCP server. The desktop app is the MCP client and always initiates the public network connection.
- MCP transport: HTTPS Streamable HTTP.
- Initial authentication: fixed bearer token.
- Authentication must be behind an adapter so OAuth 2.1 with PKCE can replace bearer tokens later without changing message or wxauto services.
- Offline events and send jobs are persisted in local SQLite.
- Local history is retained until an administrator manually clears it.
- Sensitive local data is encrypted with AES-GCM. The data-encryption key is protected by Windows DPAPI for the current Windows user.
- The existing HTTP bridge remains available during a migration period, but new installations default to MCP.
- The app provides test sending and failed-message retry, not a general-purpose chat client.
- Updates are distributed by the public board. The first unsigned internal release only checks and downloads updates, verifies a signed manifest and SHA-256 digest, and asks the user to run the installer. It does not silently replace the installed app.

## Scope

### Desktop App

The first release includes:

- WeChat process and login-state detection
- wxauto worker lifecycle management
- inbound message collection
- outbound message execution
- MCP connection management
- encrypted SQLite queues and history
- startup, tray, update checking, and diagnostics
- strict safety controls
- a complete operations UI

It does not include:

- the WeChat client
- multiple WeChat instances or accounts
- friend adding, marketing automation, bulk messaging, or group blasting
- credential automation or automated WeChat login
- process injection, protocol modification, or attempts to bypass platform detection
- arbitrary manual chat composition
- Windows 7, 32-bit Windows, or Windows ARM support

### Board

The board adds:

- a standard MCP Streamable HTTP endpoint
- bearer-token authorization
- device registration and health state
- MCP tools for inbound and outbound message exchange
- idempotency and outbound leases
- update manifest and installer distribution
- admin visibility for connected desktop agents
- compatibility adapters from the existing HTTP routes into the same application services

Business decisions remain on the board. The desktop app must not duplicate identity registration, ticket analysis, follow-up questions, ticket creation, or escalation logic.

## Architecture

### Desktop Components

#### Electron Main Process

Owns:

- application lifecycle
- system tray and startup registration
- update checks
- MCP client sessions
- SQLite queue coordination
- encryption key access
- Python worker supervision
- safety policy enforcement
- structured logging

The main process exposes a narrow, typed IPC surface to the renderer. It does not expose Node.js directly to the renderer.

#### React Renderer

Provides the graphical operations console:

- overview
- real-time event history
- send queue
- logs
- connection configuration
- safety policy status
- update status

The renderer cannot access the filesystem, secrets, SQLite, child processes, or MCP transport directly.

#### Python wxauto Worker

The worker is packaged as a sidecar executable and calls wxauto directly. The local REST shim is removed from the new desktop architecture.

The worker supports a small command protocol:

- initialize and report WeChat state
- poll or wait for new messages
- send one approved message
- perform a health check
- shut down cleanly

Electron and the worker communicate through JSON Lines over standard input and standard output. No local TCP listener is opened.

#### Encrypted SQLite Store

The database stores:

- device identity
- inbound event queue
- outbound job state
- send attempts
- event history
- safety decisions
- diagnostic records
- non-secret settings

Message bodies and sensitive fields are encrypted before insertion using AES-GCM. The AES key is protected through Windows DPAPI. MCP tokens and other secrets are also encrypted and never written to logs.

### Board Components

#### MCP Server

The board exposes one standard endpoint:

```text
POST /api/mcp
```

It uses Streamable HTTP and bearer-token authorization. MCP protocol handling must remain separate from ticket and WeChat business services.

#### Shared Integration Service

Both MCP tools and the temporary HTTP compatibility routes call shared application services:

- normalize and process inbound WeChat events
- claim outbound messages
- complete outbound messages
- update agent health

This prevents duplicate business behavior during migration.

#### Update Service

The board stores and serves:

- release metadata
- a signed update manifest
- SHA-256 installer hashes
- release notes
- installer downloads

The desktop app compares semantic versions, verifies the manifest signature and file hash, and then prompts for installation.

## MCP Contract

The board provides four tools.

### `register_wxauto_agent`

Registers or refreshes a desktop agent.

Input includes:

- stable device ID
- app version
- Windows version
- worker version
- WeChat process state
- WeChat login state
- supported capabilities
- current safety mode

Output includes:

- accepted device identity
- server time
- minimum supported app version
- recommended polling interval
- current integration enablement

### `submit_wechat_events`

Submits an ordered batch of inbound WeChat events.

Each event includes:

- device ID
- stable wxauto message ID
- conversation identity
- sender identity and display name
- direct or group context
- message text
- image references when supported
- receive time
- local sequence number

The board deduplicates by device ID and message ID. Replaying an acknowledged event must return its prior result without creating duplicate records or tickets.

### `claim_outbound_messages`

Claims pending outbound messages for the registered agent.

Input includes:

- device ID
- maximum batch size
- supported message types

The board returns a time-limited lease for each message. A claimed message cannot be assigned to another active agent during the lease. Expired leases return to the queue.

The desktop app normally polls every two seconds while active. It may progressively back off while idle and immediately return to the active interval after inbound or outbound activity.

### `complete_outbound_message`

Completes a leased outbound message.

Status values include:

- `sent`
- `failed`
- `blocked_by_safety_policy`

The result includes attempt time, sanitized error details, and the relevant safety rule when blocked. Completion is idempotent.

## Runtime Data Flow

### Inbound

1. The worker detects a new WeChat message.
2. Electron normalizes it and writes the encrypted event to SQLite before network submission.
3. The MCP client submits an ordered batch through `submit_wechat_events`.
4. The board acknowledges each event after durable processing.
5. Electron marks acknowledged events complete but retains them in history until manual cleanup.

### Outbound

1. The board creates an outbound message through existing business logic.
2. The desktop app calls `claim_outbound_messages`.
3. Electron checks the message against local safety policies.
4. Approved messages enter a per-conversation serial queue.
5. A conservative deterministic delay is applied before the worker sends the message.
6. Electron records the attempt and calls `complete_outbound_message`.
7. Failed jobs follow bounded retry rules or trigger a circuit breaker.

The delay is a rate-control feature, not an attempt to imitate human input or evade detection. The app does not simulate typing gestures, random mouse movement, or other deceptive interaction patterns.

## Safety Controls

The first release runs in strict safety mode:

- no bulk sends
- no automatic friend adding
- no marketing workflows
- no WeChat multi-instance support
- no process injection or protocol modification
- only board-generated business messages and explicit test messages may be sent
- messages are serialized per conversation
- duplicate outbound content is suppressed within a configurable window
- minimum send interval, per-minute limit, and daily limit are enforced
- repeated send failures, abnormal frequency, or worker instability trigger a circuit breaker
- a tripped circuit breaker pauses sending until an operator explicitly resumes it
- all delays, suppressions, blocks, and manual resumes are audited

No design can guarantee that an account will not be restricted. wxauto use remains subject to WeChat platform rules and technical changes.

## User Interface

The application uses a desktop navigation layout with these pages:

### Overview

Shows:

- WeChat process and login status
- MCP connection status and latency
- local pending-event count
- safety-mode state and daily send count
- recent inbound and outbound activity
- actionable failures
- update availability
- start, pause, test-send, and diagnostic entry points

### Real-Time Messages

Shows chronological inbound and outbound events with direction, conversation, sanitized content preview, local state, board acknowledgment, and timestamps.

### Send Queue

Shows leased, delayed, retrying, failed, sent, and safety-blocked messages. Operators can inspect errors and retry eligible failures. They cannot edit board-generated message content.

### Logs

Shows structured application, MCP, worker, WeChat-state, update, and safety logs. Logs can be filtered and exported with secrets redacted.

### Connection Configuration

Includes:

- board MCP URL
- bearer token
- connection test
- compatibility HTTP toggle during migration
- update channel
- startup and tray state

### Safety Policy

Shows configured limits, current counters, duplicate suppression, circuit-breaker state, blocked actions, and a deliberate manual-resume action.

## Failure Handling

### WeChat Is Not Running

- pause reading and sending
- display a visible warning and tray notification
- periodically recheck for the official WeChat process

### WeChat Is Logged Out

- pause wxauto activity
- prompt the operator to log in manually
- never automate credentials, QR scanning, or login approval

### Worker Is Unhealthy

- terminate the worker
- restart with exponential backoff and a maximum retry rate
- trip the circuit breaker after repeated failures

### MCP or Network Is Unavailable

- continue storing inbound events in encrypted SQLite
- do not discard acknowledged or unacknowledged history
- reconnect with bounded exponential backoff
- replay unacknowledged events in original sequence

### App Exits Unexpectedly

- restore incomplete local jobs on launch
- revalidate board leases
- never assume an unknown send attempt failed or succeeded without reconciliation

### Send Failure

- record a sanitized failure
- retry only within configured limits
- mark permanent failures for operator attention
- trigger the circuit breaker when failure thresholds are exceeded

## Updates and Distribution

The first release is an unsigned internal Windows installer. Windows may display an unknown-publisher or SmartScreen warning.

Update behavior:

1. The app checks the board update service.
2. The app verifies the signed manifest.
3. The installer is downloaded over HTTPS.
4. The SHA-256 digest is verified.
5. Downgrade and replay protection are applied.
6. The operator is prompted to run the installer.

Silent or forced background installation is out of scope until a trusted Windows code-signing certificate is available.

## Compatibility and Migration

During the migration period:

- the existing `/api/integrations/wechat/messages` and outbound HTTP routes remain available
- MCP and HTTP adapters use the same shared application services
- deduplication prevents the same wxauto message from being processed through both transports
- the desktop app defaults to MCP
- compatibility HTTP can be enabled explicitly for rollback

The old Node bridge and local REST shim can be removed after an operational validation period with no unresolved duplicate, loss, or send-reconciliation issues.

## Testing

### Desktop Unit Tests

- encrypted field round trips and authentication failures
- DPAPI key-wrapper abstraction
- SQLite queue state transitions
- message idempotency
- per-conversation serialization
- rate limits and daily limits
- duplicate suppression
- circuit breaker transitions
- retry and backoff calculations
- token redaction

### Desktop Integration Tests

- Electron main process with a simulated worker
- MCP client with a simulated board server
- worker crash and restart
- network outage and ordered replay
- app restart with pending inbound and outbound jobs
- lease reconciliation after uncertain send outcomes
- update manifest and hash verification

### Board Tests

- MCP initialization and Streamable HTTP handling
- bearer-token authorization
- all four tool schemas and results
- inbound idempotency
- outbound leases and lease expiry
- completion idempotency
- shared behavior across MCP and compatibility HTTP adapters
- connected-agent status
- update manifest and installer access

### Windows Acceptance Tests

- install on Windows 10 x64 and Windows 11 x64
- start with Windows
- close to tray and restore
- detect WeChat start, exit, login, and logout
- receive and submit a real test message
- send a board-generated test message
- recover from network loss without message loss
- recover from worker failure
- trip and manually resume the circuit breaker
- download and verify an update

### Security Tests

- renderer has no Node integration
- context isolation is enabled
- IPC methods are allowlisted and validated
- no local listening port is opened
- secrets never appear in logs or exports
- copied SQLite files cannot be decrypted under a different Windows user without the protected key
- malformed MCP and worker messages are rejected

## Success Criteria

The first release is successful when:

- one official Windows WeChat instance can remain connected through the tray app
- inbound messages survive network and application restarts without duplication or loss
- board-generated outbound messages have traceable lease, delay, send, and completion states
- operators can diagnose normal failures without using a terminal
- strict safety limits prevent burst, duplicate, or unsupported sends
- the board contains one business implementation shared by MCP and temporary HTTP adapters
- the desktop app can later adopt OAuth 2.1 with PKCE by replacing the authentication adapter rather than the transport and message pipeline

## Self-Review

- The connection direction is consistent: the desktop MCP client initiates all public connections to the board MCP server.
- Standard MCP is used for the new transport; the old HTTP routes are explicitly compatibility adapters, not described as MCP.
- Conservative send delays are defined as deterministic rate controls and do not include detection-evasion behavior.
- The installer does not bundle WeChat and does not automate login.
- Unsigned first-release limitations are explicit, and silent automatic installation is excluded.
- Desktop and board work are separate release units with clear ownership.
- No unresolved placeholders or implementation-critical ambiguities remain.
