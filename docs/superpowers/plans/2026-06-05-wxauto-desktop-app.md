# wxauto Desktop MCP App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a separately installed Windows operations app that supervises wxauto, persists encrypted work, connects to the board through standard MCP, enforces strict send controls, and exposes a complete React GUI.

**Architecture:** A hardened Electron main process owns MCP, SQLite, encryption, worker supervision, safety policy, updates, tray, and startup. A sandboxed React renderer receives typed snapshots through a narrow preload API. A bundled 32-bit Python sidecar talks to wxauto over JSON Lines and never opens a local network port.

**Tech Stack:** Electron 42, React 19, TypeScript 6, electron-vite 5, electron-builder 26, Vitest 4, Zod 4, `@modelcontextprotocol/sdk@1.29.0`, better-sqlite3 12, Python 3.12 x86, wxauto 39.2.1, PyInstaller 6

---

## Prerequisite

Complete `docs/superpowers/plans/2026-06-05-wxauto-board-mcp-server.md` first. This plan consumes the four MCP tools and signed update-manifest format defined there.

Create the app as a sibling repository:

```text
C:\Users\TianGong\主场看板\wxauto-desktop
```

The Electron application is Windows x64. The first wxauto worker build is Windows x86 because the validated local Python/wxauto environment is Python 3.12 32-bit. Keep the worker architecture explicit in release metadata so a future x64 worker can replace it independently.

## File Structure

```text
wxauto-desktop/
  build/
    icon.ico
  resources/
    update-public-key.pem
    worker/
      wxauto-worker.exe
  src/
    main/
      app-controller.ts
      bootstrap.ts
      config/
        auth-provider.ts
        config-store.ts
      crypto/
        encrypted-json.ts
        key-protector.ts
      db/
        database.ts
        migrations.ts
        queue-repository.ts
      ipc/
        register-ipc.ts
      mcp/
        board-client.ts
        sync-engine.ts
      safety/
        policy-engine.ts
      tray/
        tray-controller.ts
      updates/
        update-client.ts
      worker/
        protocol.ts
        supervisor.ts
    preload/
      index.ts
      types.ts
    renderer/
      src/
        App.tsx
        components/
        pages/
        state/
        styles/
    shared/
      contracts.ts
      ipc.ts
      redaction.ts
  worker/
    wxauto_worker/
      __init__.py
      adapter.py
      main.py
      protocol.py
    tests/
      test_protocol.py
      test_worker.py
    requirements-build.txt
    wxauto-worker.spec
  tests/
    main/
    renderer/
    integration/
  electron-builder.yml
  electron.vite.config.ts
  package.json
  tsconfig.json
  vitest.config.ts
```

## Task 1: Scaffold the Independent Electron Repository

**Files:**
- Create: sibling directory `..\wxauto-desktop`
- Create: `package.json`
- Create: `electron.vite.config.ts`
- Create: `electron-builder.yml`
- Create: `src/main/index.ts`
- Create: `src/preload/index.ts`
- Create: `src/renderer/src/App.tsx`
- Create: `src/renderer/index.html`
- Create: `.gitignore`

- [ ] **Step 1: Create the repository and install pinned dependencies**

Run from the board repository:

```powershell
New-Item -ItemType Directory -Force '..\wxauto-desktop' | Out-Null
Set-Location '..\wxauto-desktop'
git init
npm.cmd init -y
npm.cmd install react@19.2.7 react-dom@19.2.7 zod@4.4.3 @modelcontextprotocol/sdk@1.29.0 better-sqlite3@12.10.0
npm.cmd install -D electron@42.3.3 electron-vite@5.0.0 electron-builder@26.8.1 typescript@6.0.3 vitest@4.1.7 @vitejs/plugin-react@6.0.2 @types/node@24.13.0 @types/react@19.2.16 @types/react-dom@19.2.3 @types/better-sqlite3@7.6.13 @testing-library/react@16.3.2 @testing-library/user-event@14.6.1 jsdom@29.1.1
```

- [ ] **Step 2: Define scripts and security-oriented build settings**

Set `package.json` scripts:

```json
{
  "scripts": {
    "postinstall": "electron-builder install-app-deps",
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "test": "vitest",
    "test:run": "vitest run",
    "typecheck": "tsc --noEmit",
    "worker:test": "python -m pytest worker/tests",
    "worker:build": "powershell -ExecutionPolicy Bypass -File scripts/build-worker.ps1",
    "dist": "npm run build && electron-builder --win nsis --x64"
  }
}
```

Run the native dependency rebuild once after adding the scripts:

```powershell
npm.cmd run postinstall
```

This rebuilds `better-sqlite3` for Electron's x64 Node ABI rather than the ordinary command-line Node ABI.

Configure the main window:

```ts
new BrowserWindow({
  width: 1280,
  height: 820,
  minWidth: 1040,
  minHeight: 680,
  show: false,
  webPreferences: {
    preload: join(__dirname, "../preload/index.js"),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true
  }
});
```

Configure `electron-builder.yml`:

```yaml
appId: com.zhuchang.wxauto
productName: wxauto Desktop
asar: true
files:
  - out/**
extraResources:
  - from: resources/worker
    to: worker
  - from: resources/update-public-key.pem
    to: update-public-key.pem
win:
  target:
    - target: nsis
      arch:
        - x64
  artifactName: wxauto-desktop-Setup-${version}.${ext}
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
```

- [ ] **Step 3: Add the first application smoke test**

Create `tests/main/window-options.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { windowWebPreferences } from "../../src/main/window-options";

describe("window security", () => {
  it("keeps renderer privileges disabled", () => {
    expect(windowWebPreferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    });
  });
});
```

Extract the options to `src/main/window-options.ts` and consume them from the BrowserWindow constructor.

- [ ] **Step 4: Run the scaffold verification**

```powershell
npm.cmd run test:run
npm.cmd run typecheck
npm.cmd run build
```

Expected: all commands pass and Electron/Vite produces `out/main`, `out/preload`, and `out/renderer`.

- [ ] **Step 5: Commit**

```powershell
git add .
git commit -m "chore: scaffold wxauto desktop app"
```

## Task 2: Define Shared Contracts, IPC, Redaction, and Authentication Boundary

**Files:**
- Create: `src/shared/contracts.ts`
- Create: `src/shared/ipc.ts`
- Create: `src/shared/redaction.ts`
- Create: `src/main/config/auth-provider.ts`
- Create: `tests/main/contracts.test.ts`
- Create: `tests/main/redaction.test.ts`

- [ ] **Step 1: Write failing contract tests**

Create `tests/main/contracts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  appConfigSchema,
  workerMessageSchema,
  outboundLeaseSchema
} from "../../src/shared/contracts";

describe("desktop contracts", () => {
  it("requires HTTPS for non-local board endpoints", () => {
    expect(() => appConfigSchema.parse({
      boardUrl: "http://board.example/api/mcp",
      updateChannel: "stable",
      startAtLogin: true
    })).toThrow();
    expect(appConfigSchema.parse({
      boardUrl: "http://localhost:3000/api/mcp",
      updateChannel: "stable",
      startAtLogin: true
    }).boardUrl).toContain("localhost");
  });

  it("accepts only supported worker events and outbound text leases", () => {
    expect(workerMessageSchema.parse({
      id: "req-1",
      ok: true,
      result: { state: "logged_in" }
    }).ok).toBe(true);
    expect(outboundLeaseSchema.parse({
      messageId: "out-1",
      leaseId: "lease-1",
      leaseExpiresAt: "2026-06-05T08:01:00.000Z",
      targetName: "Front Desk",
      text: "Received",
      createdAt: "2026-06-05T08:00:00.000Z"
    }).messageId).toBe("out-1");
  });
});
```

- [ ] **Step 2: Add Zod schemas**

`src/shared/contracts.ts` must define:

```ts
import { z } from "zod";

const secureBoardUrl = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) {
    context.addIssue({ code: "custom", message: "Remote board URL must use HTTPS" });
  }
});

export const appConfigSchema = z.object({
  boardUrl: secureBoardUrl,
  updateChannel: z.enum(["stable", "beta"]).default("stable"),
  startAtLogin: z.boolean().default(true),
  compatibilityHttpEnabled: z.boolean().default(false)
});

export const workerRequestSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["initialize", "health", "poll_messages", "send_message", "shutdown"]),
  payload: z.record(z.string(), z.unknown()).default({})
});

export const workerMessageSchema = z.object({
  id: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional()
}).refine((value) => value.ok ? value.error === undefined : value.error !== undefined);

export const outboundLeaseSchema = z.object({
  messageId: z.string().min(1),
  leaseId: z.string().min(1),
  leaseExpiresAt: z.string().datetime({ offset: true }),
  targetName: z.string().min(1),
  targetConversationId: z.string().optional(),
  text: z.string(),
  createdAt: z.string().datetime({ offset: true })
});
```

- [ ] **Step 3: Create an OAuth-ready auth interface**

Create `src/main/config/auth-provider.ts`:

```ts
export interface AuthProvider {
  getHeaders(): Promise<Record<string, string>>;
  describe(): { kind: "bearer" | "oauth"; authenticated: boolean };
  clear(): Promise<void>;
}

export class BearerAuthProvider implements AuthProvider {
  constructor(private readonly readToken: () => Promise<string | undefined>) {}

  async getHeaders() {
    const token = await this.readToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async clear() {}

  describe() {
    return { kind: "bearer" as const, authenticated: true };
  }
}
```

The board client may depend only on `AuthProvider`, never directly on token storage. A later `OAuthPkceAuthProvider` can implement the same interface.

- [ ] **Step 4: Add explicit IPC channel constants and secret redaction**

`src/shared/ipc.ts`:

```ts
export const IPC = {
  snapshot: "app:snapshot",
  configure: "app:configure",
  testConnection: "app:test-connection",
  testSend: "app:test-send",
  retryMessage: "app:retry-message",
  pauseSending: "app:pause-sending",
  resumeSafety: "app:resume-safety",
  clearHistory: "app:clear-history",
  exportLogs: "app:export-logs",
  checkUpdates: "app:check-updates"
} as const;
```

`src/shared/redaction.ts` must recursively replace values whose keys match:

```ts
/token|authorization|secret|password|private.?key/i
```

and redact bearer-looking text inside arbitrary strings.

- [ ] **Step 5: Run tests and commit**

```powershell
npm.cmd run test:run -- tests/main/contracts.test.ts tests/main/redaction.test.ts
npm.cmd run typecheck
git add src tests
git commit -m "feat: define desktop contracts and auth boundary"
```

## Task 3: Implement DPAPI-Protected AES-GCM Storage and SQLite Queues

**Files:**
- Create: `src/main/crypto/key-protector.ts`
- Create: `src/main/crypto/encrypted-json.ts`
- Create: `src/main/db/migrations.ts`
- Create: `src/main/db/database.ts`
- Create: `src/main/db/queue-repository.ts`
- Create: `tests/main/encrypted-json.test.ts`
- Create: `tests/main/queue-repository.test.ts`

- [ ] **Step 1: Write failing encryption tests**

```ts
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptJson, encryptJson } from "../../src/main/crypto/encrypted-json";

it("round trips encrypted JSON and rejects the wrong key", () => {
  const key = randomBytes(32);
  const encrypted = encryptJson(key, { text: "sensitive message" });
  expect(encrypted).not.toContain("sensitive message");
  expect(decryptJson(key, encrypted)).toEqual({ text: "sensitive message" });
  expect(() => decryptJson(randomBytes(32), encrypted)).toThrow();
});
```

- [ ] **Step 2: Implement an injectable key protector**

```ts
export interface KeyProtector {
  protect(bytes: Buffer): Buffer;
  unprotect(bytes: Buffer): Buffer;
}
```

The production implementation wraps Electron `safeStorage.encryptString` and `safeStorage.decryptString`. Store the DPAPI-wrapped base64 data key in:

```text
<app.getPath("userData")>\secrets\data-key.dpapi
```

Generate exactly 32 random bytes on first run. Never place the unwrapped key or bearer token in logs.

- [ ] **Step 3: Implement AES-256-GCM envelopes**

Use this serialized shape:

```ts
type EncryptedEnvelope = {
  v: 1;
  iv: string;
  tag: string;
  ciphertext: string;
};
```

Use a fresh 12-byte IV for every value and authenticate the literal associated-data string `wxauto-desktop:v1`.

- [ ] **Step 4: Write failing queue transition tests**

Create a temporary SQLite database and assert:

```ts
const event = repository.enqueueInbound({
  externalId: "wx-1",
  sequence: 1,
  payload: { senderName: "Alice", text: "A01 offline" }
});
expect(repository.pendingInbound(10)[0].externalId).toBe("wx-1");
repository.acknowledgeInbound(event.id, { action: "processed" });
expect(repository.pendingInbound(10)).toEqual([]);
expect(repository.history(10)[0].payload.text).toBe("A01 offline");
```

Also assert:

- inserting the same inbound `externalId` twice returns the original row
- an outbound lease can transition `leased -> delayed -> sending -> sent`
- an app restart converts `sending` to `uncertain`, never directly to `failed`
- history remains until `clearHistory` is explicitly called

- [ ] **Step 5: Add the schema**

`src/main/db/migrations.ts` creates:

```sql
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_encrypted TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbound_events (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  sequence INTEGER NOT NULL,
  payload_encrypted TEXT NOT NULL,
  state TEXT NOT NULL,
  receipt_encrypted TEXT,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT
);

CREATE TABLE IF NOT EXISTS outbound_jobs (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  lease_id TEXT NOT NULL UNIQUE,
  lease_expires_at TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  payload_encrypted TEXT NOT NULL,
  state TEXT NOT NULL,
  available_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_encrypted TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,
  category TEXT NOT NULL,
  payload_encrypted TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS safety_audit (
  id TEXT PRIMARY KEY,
  decision TEXT NOT NULL,
  rule TEXT NOT NULL,
  context_encrypted TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

Set:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

- [ ] **Step 6: Run and commit**

```powershell
npm.cmd run test:run -- tests/main/encrypted-json.test.ts tests/main/queue-repository.test.ts
npm.cmd run typecheck
git add src/main/crypto src/main/db tests/main
git commit -m "feat: add encrypted durable desktop queues"
```

## Task 4: Implement the Deterministic Safety Policy Engine

**Files:**
- Create: `src/main/safety/policy-engine.ts`
- Create: `tests/main/policy-engine.test.ts`

- [ ] **Step 1: Write failing policy tests**

Cover these cases with a fake clock:

```ts
const policy = new SafetyPolicyEngine({
  minimumIntervalMs: 5000,
  perMinuteLimit: 6,
  dailyLimit: 200,
  duplicateWindowMs: 10 * 60_000,
  failureTripCount: 3
}, clock);
```

Assert:

- the first board-generated text message is allowed with a deterministic `sendAfter`
- messages in the same conversation are serialized
- identical text to the same conversation within ten minutes is blocked
- the seventh send in one minute is delayed or blocked according to policy
- the 201st send in one day is blocked
- unsupported source or message type is blocked
- three consecutive worker failures trip the circuit breaker
- a tripped breaker stays paused until explicit manual resume

- [ ] **Step 2: Implement typed decisions**

```ts
export type SafetyDecision =
  | { outcome: "allow"; sendAfter: string; rule: "approved" }
  | { outcome: "delay"; sendAfter: string; rule: "minimum_interval" | "per_minute_limit" }
  | { outcome: "block"; rule: "duplicate" | "daily_limit" | "unsupported" | "circuit_breaker" };
```

Use persisted history/audit data for duplicate and count checks. Do not add randomness, simulated typing, mouse motion, or any behavior intended to evade detection.

- [ ] **Step 3: Audit every nontrivial decision**

Persist delay, block, breaker-trip, and manual-resume decisions through `QueueRepository.recordSafetyDecision`. Redact message previews to a bounded length.

- [ ] **Step 4: Verify and commit**

```powershell
npm.cmd run test:run -- tests/main/policy-engine.test.ts
npm.cmd run typecheck
git add src/main/safety tests/main/policy-engine.test.ts
git commit -m "feat: enforce strict outbound safety policy"
```

## Task 5: Build the Python wxauto Sidecar and Protocol

**Files:**
- Create: `worker/requirements-build.txt`
- Create: `worker/wxauto_worker/protocol.py`
- Create: `worker/wxauto_worker/adapter.py`
- Create: `worker/wxauto_worker/main.py`
- Create: `worker/tests/test_protocol.py`
- Create: `worker/tests/test_worker.py`
- Create: `worker/wxauto-worker.spec`
- Create: `scripts/build-worker.ps1`

- [ ] **Step 1: Pin the worker build environment**

`worker/requirements-build.txt`:

```text
wxauto==39.2.1
pyinstaller==6.20.0
pytest==9.0.3
```

Before installing, verify the interpreter:

```powershell
python -c "import platform,struct; print(platform.python_version(), struct.calcsize('P') * 8)"
```

Expected for the first worker release: Python 3.12 and `32`.

- [ ] **Step 2: Write protocol tests before importing wxauto**

The protocol layer must be testable without WeChat or wxauto installed:

```py
def test_valid_health_request():
    request = parse_request('{"id":"1","type":"health","payload":{}}')
    assert request.request_id == "1"
    assert request.request_type == "health"

def test_protocol_rejects_unknown_command():
    with pytest.raises(ProtocolError):
        parse_request('{"id":"1","type":"execute_python","payload":{}}')
```

- [ ] **Step 3: Define a narrow adapter interface**

`worker/wxauto_worker/adapter.py`:

```py
class WechatAdapter(Protocol):
    def initialize(self) -> dict: ...
    def health(self) -> dict: ...
    def poll_messages(self) -> list[dict]: ...
    def send_text(self, target_name: str, text: str) -> dict: ...
    def close(self) -> None: ...
```

The production adapter imports `wxauto.WeChat` lazily during `initialize`. It maps library-specific objects to plain dictionaries with stable fields. It must not expose arbitrary method invocation.

- [ ] **Step 4: Implement JSON Lines request/response**

`main.py` reads one UTF-8 JSON object per line from stdin and writes exactly one JSON response per request to stdout:

```json
{"id":"req-1","ok":true,"result":{"processState":"running","loginState":"logged_in"}}
```

Diagnostics go to stderr as structured JSON. Never print message bodies or tokens to stderr.

When started with `--version`, the worker writes one metadata JSON object and exits successfully:

```json
{"workerVersion":"0.1.0","pythonVersion":"3.12","architecture":"x86","wxautoVersion":"39.2.1"}
```

Supported commands:

- `initialize`
- `health`
- `poll_messages`
- `send_message`, text only
- `shutdown`

- [ ] **Step 5: Test with a fake adapter**

Tests must verify:

- initialize reports process/login state
- poll returns normalized ordered events
- send rejects empty targets and unsupported message types
- adapter exceptions become sanitized error codes
- shutdown closes the adapter
- malformed JSON does not terminate the command loop

- [ ] **Step 6: Add the x86 PyInstaller build**

`scripts/build-worker.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
$bits = python -c "import struct; print(struct.calcsize('P') * 8)"
if ($bits -ne '32') { throw 'The first wxauto worker must be built with 32-bit Python.' }
python -m pip install -r worker/requirements-build.txt
python -m pytest worker/tests
python -m PyInstaller --clean --noconfirm worker/wxauto-worker.spec
New-Item -ItemType Directory -Force resources/worker | Out-Null
Copy-Item -Force dist/wxauto-worker.exe resources/worker/wxauto-worker.exe
```

- [ ] **Step 7: Verify and commit**

```powershell
python -m pytest worker/tests
npm.cmd run worker:build
& .\resources\worker\wxauto-worker.exe --version
git add worker scripts/build-worker.ps1 resources/worker/.gitkeep
git commit -m "feat: add packaged wxauto worker sidecar"
```

Do not commit the generated `.exe`; release builds create it before `electron-builder`.

## Task 6: Implement the Worker Supervisor

**Files:**
- Create: `src/main/worker/protocol.ts`
- Create: `src/main/worker/supervisor.ts`
- Create: `tests/main/worker-supervisor.test.ts`
- Create: `tests/fixtures/fake-worker.mjs`

- [ ] **Step 1: Write failing supervisor tests**

Use the fake worker process to verify:

- requests correlate by ID even when responses are delayed
- malformed stdout is treated as a worker fault
- request timeouts reject and are audited
- a crash restarts with bounded exponential backoff
- repeated crashes trip the circuit breaker
- shutdown sends the command before force termination
- no local TCP port is opened

- [ ] **Step 2: Resolve packaged and development worker paths**

```ts
export function resolveWorkerPath() {
  return app.isPackaged
    ? join(process.resourcesPath, "worker", "wxauto-worker.exe")
    : join(app.getAppPath(), "resources", "worker", "wxauto-worker.exe");
}
```

- [ ] **Step 3: Spawn with a minimal environment**

Use `child_process.spawn(workerPath, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })`. Pass only required locale/system environment values. Do not pass the MCP bearer token.

Backoff:

```ts
Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6))
```

Reset the restart counter after five healthy minutes.

- [ ] **Step 4: Verify and commit**

```powershell
npm.cmd run test:run -- tests/main/worker-supervisor.test.ts
npm.cmd run typecheck
git add src/main/worker tests/main/worker-supervisor.test.ts tests/fixtures/fake-worker.mjs
git commit -m "feat: supervise wxauto worker lifecycle"
```

## Task 7: Implement the Standard MCP Client and Ordered Sync Engine

**Files:**
- Create: `src/main/mcp/board-client.ts`
- Create: `src/main/mcp/sync-engine.ts`
- Create: `tests/main/board-client.test.ts`
- Create: `tests/integration/sync-engine.test.ts`

- [ ] **Step 1: Write a real SDK interoperability test**

Start the board's MCP route in a test server or use a local fake built with the same official SDK. The desktop test must create:

```ts
const transport = new StreamableHTTPClientTransport(new URL(boardUrl), {
  requestInit: { headers: await authProvider.getHeaders() }
});
const client = new Client({ name: "wxauto-desktop", version: "0.1.0" });
await client.connect(transport);
```

Assert the client can call `register_wxauto_agent` and parse its structured result.

- [ ] **Step 2: Wrap only the four board tools**

`BoardClient` methods:

```ts
registerAgent(status: AgentStatus): Promise<RegistrationResult>;
submitEvents(events: LocalInboundEvent[]): Promise<EventReceipt[]>;
claimOutbound(limit: number): Promise<OutboundLease[]>;
completeOutbound(result: OutboundCompletion): Promise<void>;
```

Validate every tool result with local Zod schemas. Treat malformed results as protocol failures, not empty success.

- [ ] **Step 3: Write sync-engine failure tests**

Verify:

- inbound is written locally before MCP submission
- acknowledgements mark only matching events complete
- network failure leaves events pending in sequence order
- reconnect replays pending events without changing external IDs
- outbound leases are inserted idempotently by `leaseId`
- idle polling backs off and activity returns to the server-recommended interval
- expired leases are never sent
- startup preserves `uncertain` sends for operator reconciliation

- [ ] **Step 4: Implement bounded reconnect and polling**

Use deterministic reconnect delays:

```ts
const reconnectMs = Math.min(60_000, 1000 * 2 ** Math.min(failures, 6));
```

Use the server's `recommendedPollIntervalMs` while active, then step through `5s`, `10s`, and `30s` during sustained idle. Any inbound event, claimed outbound job, or manual refresh returns to the active interval.

- [ ] **Step 5: Verify and commit**

```powershell
npm.cmd run test:run -- tests/main/board-client.test.ts tests/integration/sync-engine.test.ts
npm.cmd run typecheck
git add src/main/mcp tests/main/board-client.test.ts tests/integration/sync-engine.test.ts
git commit -m "feat: synchronize queues through standard MCP"
```

## Task 8: Execute Outbound Jobs with Serialization and Reconciliation

**Files:**
- Create: `src/main/outbound/outbound-executor.ts`
- Create: `tests/integration/outbound-executor.test.ts`

- [ ] **Step 1: Write failing execution tests**

Verify:

- jobs for the same conversation never overlap
- independent conversations may be scheduled independently but still obey global limits
- an allowed job waits until `sendAfter`
- a successful worker result is persisted before MCP completion
- a worker timeout becomes `uncertain`, not automatically retried
- a known pre-send failure may retry within the configured bound
- safety blocks call `complete_outbound_message` with `blocked_by_safety_policy`
- repeated failures trip the breaker and pause subsequent jobs
- manual retry creates a new local attempt without editing board content

- [ ] **Step 2: Implement explicit send phases**

Persist every transition:

```text
leased -> policy_check -> delayed -> sending -> sent
                                      |-> failed
                                      |-> uncertain
             |-> blocked_by_safety_policy
```

Only `sent`, known `failed`, and `blocked_by_safety_policy` are reported to the board. `uncertain` requires lease reconciliation or operator action.

- [ ] **Step 3: Add test-send as a separate source**

The GUI test-send action must:

- require a target name and text
- show a confirmation dialog
- pass through the same safety policy and worker supervisor
- be recorded with source `operator_test`
- never be represented as a board outbound lease

- [ ] **Step 4: Verify and commit**

```powershell
npm.cmd run test:run -- tests/integration/outbound-executor.test.ts
npm.cmd run typecheck
git add src/main/outbound tests/integration/outbound-executor.test.ts
git commit -m "feat: execute outbound jobs with reconciliation"
```

## Task 9: Expose a Narrow Preload API and Main Application Controller

**Files:**
- Create: `src/main/app-controller.ts`
- Create: `src/main/bootstrap.ts`
- Create: `src/main/ipc/register-ipc.ts`
- Modify: `src/preload/index.ts`
- Create: `src/preload/types.ts`
- Create: `tests/main/ipc.test.ts`

- [ ] **Step 1: Write failing IPC allowlist tests**

Assert that the preload API exposes only:

```ts
{
  getSnapshot,
  configure,
  testConnection,
  testSend,
  retryMessage,
  pauseSending,
  resumeSafety,
  clearHistory,
  exportLogs,
  checkUpdates,
  subscribe
}
```

There must be no generic `invoke(channel, payload)`, filesystem API, shell API, database API, or process API.

- [ ] **Step 2: Validate every IPC payload**

Use Zod schemas in `src/shared/ipc.ts`. `ipcMain.handle` rejects invalid payloads before calling services. Validate IDs and bounded strings for retry, test-send, and export filters.

- [ ] **Step 3: Implement a serializable application snapshot**

The controller publishes:

```ts
type AppSnapshot = {
  appVersion: string;
  running: boolean;
  sendingPaused: boolean;
  wechat: { processState: string; loginState: string; workerState: string };
  mcp: { state: string; latencyMs?: number; lastConnectedAt?: string; lastError?: string };
  queue: { inboundPending: number; outboundPending: number; uncertain: number; failed: number };
  safety: { state: "normal" | "paused" | "tripped"; sentToday: number; dailyLimit: number; reason?: string };
  update: { state: string; availableVersion?: string };
  recentHistory: HistoryItem[];
  recentLogs: LogItem[];
};
```

Sanitize errors before they enter the snapshot.

- [ ] **Step 4: Bootstrap in dependency order**

1. single-instance lock
2. app paths and logging
3. key protector and data key
4. SQLite and migrations
5. config/auth provider
6. safety engine
7. worker supervisor
8. board client and sync engine
9. outbound executor
10. tray, IPC, and BrowserWindow

On shutdown, stop polling, stop outbound execution, close MCP, request worker shutdown, checkpoint SQLite, then quit.

- [ ] **Step 5: Verify and commit**

```powershell
npm.cmd run test:run -- tests/main/ipc.test.ts
npm.cmd run typecheck
git add src/main src/preload tests/main/ipc.test.ts
git commit -m "feat: expose secure desktop application API"
```

## Task 10: Build the Complete React Operations Console

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Create: `src/renderer/src/pages/OverviewPage.tsx`
- Create: `src/renderer/src/pages/MessagesPage.tsx`
- Create: `src/renderer/src/pages/SendQueuePage.tsx`
- Create: `src/renderer/src/pages/LogsPage.tsx`
- Create: `src/renderer/src/pages/ConnectionPage.tsx`
- Create: `src/renderer/src/pages/SafetyPage.tsx`
- Create: `src/renderer/src/components/StatusCard.tsx`
- Create: `src/renderer/src/components/ConfirmDialog.tsx`
- Create: `src/renderer/src/state/useAppSnapshot.ts`
- Create: `src/renderer/src/styles/app.css`
- Create: `tests/renderer/app.test.tsx`
- Create: `tests/renderer/connection-page.test.tsx`
- Create: `tests/renderer/safety-page.test.tsx`

- [ ] **Step 1: Write page behavior tests**

Test the approved structure:

- left navigation with Overview, Real-time Messages, Send Queue, Logs, Connection, Safety
- overview status cards for WeChat, MCP, local queue, safety, and updates
- prominent warning when WeChat is not running or logged out
- failed and uncertain jobs are actionable
- board-generated message content is inspectable but not editable
- bearer token input is masked and never returned in snapshots
- circuit-breaker resume requires confirmation
- test-send requires confirmation and is clearly labeled as an operator test

- [ ] **Step 2: Implement renderer state subscription**

`useAppSnapshot` loads one initial snapshot and subscribes to push updates. Remove the listener on unmount. Do not poll from the renderer.

- [ ] **Step 3: Implement accessible navigation and status**

Requirements:

- semantic buttons and headings
- visible keyboard focus
- `aria-live="polite"` for connection/state changes
- color is not the only status indicator
- no auto-dismiss for critical errors
- tables collapse to cards below the minimum desktop width

- [ ] **Step 4: Implement configuration behavior**

Connection page fields:

- board MCP URL
- bearer token, write-only
- connection test
- compatibility HTTP toggle
- update channel
- start at login

Never prefill the stored token. Show only `Token configured` or `Token not configured`.

- [ ] **Step 5: Verify renderer and build**

```powershell
npm.cmd run test:run -- tests/renderer
npm.cmd run typecheck
npm.cmd run build
```

Expected: all tests pass and the production renderer contains no Node polyfills or secret values.

- [ ] **Step 6: Commit**

```powershell
git add src/renderer tests/renderer
git commit -m "feat: add wxauto operations console"
```

## Task 11: Add Tray, Startup, Notifications, and Diagnostics

**Files:**
- Create: `src/main/tray/tray-controller.ts`
- Create: `src/main/diagnostics/diagnostics-service.ts`
- Create: `tests/main/tray-controller.test.ts`
- Create: `tests/main/diagnostics-service.test.ts`

- [ ] **Step 1: Write behavior tests**

Verify:

- closing the main window hides it to tray unless the app is quitting
- tray menu shows status, open, pause/resume, diagnostics, and quit
- startup setting uses `app.setLoginItemSettings`
- notifications are rate-limited
- logs and diagnostics redact secrets and message bodies beyond a short preview
- diagnostic export includes versions, architecture, state counts, and recent sanitized errors

- [ ] **Step 2: Add explicit tray status**

Menu labels must distinguish:

- WeChat not running
- WeChat logged out
- MCP disconnected
- sending paused
- safety circuit tripped
- normal operation

Do not claim the system is healthy based only on the worker process being alive.

- [ ] **Step 3: Add startup and single-instance behavior**

The second instance focuses the existing window. Startup launches hidden to tray after the first successful setup; initial setup launches the window.

- [ ] **Step 4: Verify and commit**

```powershell
npm.cmd run test:run -- tests/main/tray-controller.test.ts tests/main/diagnostics-service.test.ts
npm.cmd run typecheck
git add src/main/tray src/main/diagnostics tests/main
git commit -m "feat: add tray startup and diagnostics"
```

## Task 12: Implement Signed Update Checking and Download

**Files:**
- Create: `src/main/updates/update-client.ts`
- Create: `tests/main/update-client.test.ts`
- Create: `resources/update-public-key.pem`

- [ ] **Step 1: Write signature and hash tests**

Use an ephemeral Ed25519 key pair to verify:

- valid manifest signature is accepted
- modified payload is rejected
- malformed JSON is rejected after signature verification
- channel mismatch is ignored
- same or older semantic version is ignored
- installer SHA-256 mismatch deletes the temporary file
- successful download is moved to the app update directory

- [ ] **Step 2: Verify the exact board manifest format**

The endpoint returns:

```ts
type SignedManifest = {
  payload: string;
  signature: string;
};
```

Verify:

```ts
verify(
  null,
  Buffer.from(manifest.payload),
  publicKeyPem,
  Buffer.from(manifest.signature, "base64")
);
```

Only then parse `payload` and validate it with Zod.

- [ ] **Step 3: Download safely**

Requirements:

- HTTPS except localhost development
- maximum installer size configured before download
- stream to `<userData>\updates\<version>.partial`
- compute SHA-256 while streaming
- rename only after hash success
- never execute automatically
- ask the operator, then use `shell.openPath(installerPath)`

The first unsigned internal release must warn that Windows may show an unknown-publisher or SmartScreen prompt.

- [ ] **Step 4: Embed the production public key**

Generate keys from the board plan. Commit only the SPKI public key to `resources/update-public-key.pem`. Keep the private key exclusively in board deployment secrets.

- [ ] **Step 5: Verify and commit**

```powershell
npm.cmd run test:run -- tests/main/update-client.test.ts
npm.cmd run typecheck
git add src/main/updates tests/main/update-client.test.ts resources/update-public-key.pem
git commit -m "feat: verify and download signed updates"
```

## Task 13: Package the x64 App with the x86 Worker

**Files:**
- Modify: `electron-builder.yml`
- Create: `scripts/verify-package.ps1`
- Create: `docs/build-and-release.md`

- [ ] **Step 1: Add worker metadata**

At build time, generate:

```json
{
  "workerVersion": "0.1.0",
  "pythonVersion": "3.12",
  "architecture": "x86",
  "wxautoVersion": "39.2.1"
}
```

Place it beside `wxauto-worker.exe` and report it during agent registration.

- [ ] **Step 2: Build in the required order**

```powershell
npm.cmd run worker:build
npm.cmd run test:run
npm.cmd run typecheck
npm.cmd run dist
```

- [ ] **Step 3: Verify package contents**

`scripts/verify-package.ps1` must fail unless:

- installer exists
- unpacked Electron executable is x64
- worker executable exists and reports x86 metadata
- public update key exists
- no `.env`, test database, raw token, private signing key, Python source, or log file is included

- [ ] **Step 4: Install and smoke-test locally**

On Windows 10 x64 and Windows 11 x64:

1. install per-user
2. launch and complete connection setup
3. close to tray and restore
4. verify startup setting
5. verify WeChat process/login detection
6. uninstall while preserving or explicitly offering to remove user data

- [ ] **Step 5: Commit**

```powershell
git add electron-builder.yml scripts/verify-package.ps1 docs/build-and-release.md
git commit -m "build: package x64 desktop with x86 worker"
```

## Task 14: End-to-End Acceptance and Migration Trial

**Files:**
- Create: `tests/integration/full-flow.test.ts`
- Create: `docs/acceptance-checklist.md`
- Create: `docs/http-to-mcp-migration.md`
- Modify: `README.md`

- [ ] **Step 1: Automate the recoverable full flow**

With a simulated worker and test board:

1. worker emits an inbound event
2. event is encrypted and queued
3. network fails
4. app restarts
5. network returns
6. event is submitted once and acknowledged
7. outbound lease is claimed
8. policy delays it
9. worker sends it
10. local success is persisted
11. board completion succeeds

Assert one inbound receipt, one worker send, and one outbound completion.

- [ ] **Step 2: Run real WeChat acceptance with a test account**

Use one operator-controlled test conversation. Verify:

- official WeChat is installed separately
- manual login only
- one inbound text reaches the board
- one board-generated response returns through the leased flow
- deterministic delay is visible in the audit log
- duplicate outbound content is blocked
- three simulated worker failures trip the circuit breaker
- manual resume restores sending

- [ ] **Step 3: Run outage and restart acceptance**

Verify:

- 15-minute board outage does not lose inbound events
- app restart preserves queue order
- worker crash restarts with backoff
- uncertain send is not blindly repeated
- expired lease is not sent
- local history remains until manual cleanup

- [ ] **Step 4: Run security acceptance**

Verify:

- renderer devtools cannot access `require`, filesystem, token, or SQLite
- no local listening port is opened by the app or worker
- exported logs contain no bearer token
- copied database cannot be decrypted without the DPAPI-protected data key
- update manifest tampering and hash mismatch are rejected

- [ ] **Step 5: Validate temporary HTTP rollback**

During the migration window:

- keep the old bridge disabled by default
- enable compatibility HTTP only for a documented rollback test
- confirm board idempotency prevents duplicate inbound processing
- return to MCP before ending acceptance

- [ ] **Step 6: Final verification**

```powershell
python -m pytest worker/tests
npm.cmd run test:run
npm.cmd run typecheck
npm.cmd run build
npm.cmd run dist
powershell -ExecutionPolicy Bypass -File scripts/verify-package.ps1
```

Expected: every command passes and the installer artifact is ready for board update publishing.

- [ ] **Step 7: Commit**

```powershell
git add README.md docs tests/integration/full-flow.test.ts
git commit -m "test: complete wxauto desktop acceptance flow"
```

## Plan Self-Review

- Electron x64 and worker x86 are explicit, independently versioned packaging decisions.
- The worker uses stdin/stdout JSON Lines and opens no local port.
- The renderer has no Node integration and no generic IPC escape hatch.
- Sensitive local values use AES-GCM; the random data key is protected with Windows DPAPI.
- Bearer authentication is isolated behind an interface that can be replaced by OAuth 2.1 with PKCE.
- Inbound data is persisted before submission and replayed in stable order.
- Outbound jobs use board leases, local deterministic controls, and uncertain-send reconciliation.
- Rate control is conservative and deterministic; no human imitation or detection-evasion behavior is included.
- The app detects official WeChat and prompts for manual login; it does not bundle or automate WeChat login.
- Update verification uses a board-signed Ed25519 manifest plus installer SHA-256 and never silently executes the installer.
- The existing HTTP bridge is rollback-only and disabled by default.
