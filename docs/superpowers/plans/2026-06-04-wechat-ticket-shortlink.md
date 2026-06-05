# WeChat Ticket Shortlink Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send short, clickable ticket detail links in WeChat ticket creation receipts.

**Architecture:** Add a deterministic short-link domain helper, use it in WeChat receipt formatting, and route `/t/{code}` back into the mobile app through a query parameter. The startup script writes the current Cloudflare temporary public URL to a runtime file, while `APP_PUBLIC_BASE_URL` stays the future fixed-domain override.

**Tech Stack:** Next.js App Router, React client component, TypeScript, Vitest, PowerShell startup script.

---

## File Structure

- Create: `src/lib/domain/ticket-links.ts`
  - Owns short-code derivation, `/t/{code}` path creation, absolute URL construction, and resolving short codes against loaded ticket-like objects.
- Test: `tests/domain/ticket-links.test.ts`
  - Covers deterministic short code, URL construction, missing base behavior, and resolving a code to a ticket.
- Modify: `src/lib/services/wechat-watchtower-service.ts`
  - Builds creation receipt text with the requested labels and optional short URL.
- Modify: `tests/services/wechat-watchtower-service.test.ts`
  - Adds a regression test for the new receipt format and short link.
- Create: `src/app/t/[code]/page.tsx`
  - Redirects `/t/{code}` to `/?ticketCode={code}` so the existing mobile page can load normally.
- Modify: `src/app/page.tsx`
  - Reads `ticketId` or `ticketCode` from the URL after bootstrap data loads and selects the matching ticket.
- Modify: `tests/app/page-navigation.test.tsx`
  - Adds a regression test for `?ticketCode={code}` auto-opening detail.
- Modify: `start-external.ps1`
  - Clears stale `data/public-base-url.txt` at startup and writes the new Cloudflare URL after the tunnel is ready.
- Modify: `deploy/windows/app.env.sample.ps1`
  - Documents `APP_PUBLIC_BASE_URL` for the future fixed domain.

### Task 1: Ticket Short-Link Helper

**Files:**
- Create: `src/lib/domain/ticket-links.ts`
- Test: `tests/domain/ticket-links.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/domain/ticket-links.test.ts` with tests for `ticketShortCode`, `ticketDetailPath`, `ticketDetailUrl`, and `findTicketByShortCode`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/domain/ticket-links.test.ts --run`

Expected: FAIL because `@/lib/domain/ticket-links` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/domain/ticket-links.ts` with pure helper functions. Use `new URL()` to validate and normalize base URLs.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/domain/ticket-links.test.ts --run`

Expected: PASS.

### Task 2: WeChat Creation Receipt Format

**Files:**
- Modify: `src/lib/services/wechat-watchtower-service.ts`
- Modify: `tests/services/wechat-watchtower-service.test.ts`

- [ ] **Step 1: Write the failing test**

Add a service test that sets `process.env.APP_PUBLIC_BASE_URL = "https://board.example.com"`, creates a ticket through the registration flow, and asserts the creation receipt contains the requested labels and `/t/{shortCode}`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/services/wechat-watchtower-service.test.ts --run`

Expected: FAIL because the receipt still says `已创建工单` and has no short link.

- [ ] **Step 3: Write minimal implementation**

Import the ticket link helper, add a small public-base resolver using `APP_PUBLIC_BASE_URL` first and `data/public-base-url.txt` second, then format creation receipts with the requested labels.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/services/wechat-watchtower-service.test.ts --run`

Expected: PASS.

### Task 3: Short Route and Mobile Deep Link

**Files:**
- Create: `src/app/t/[code]/page.tsx`
- Modify: `src/app/page.tsx`
- Modify: `tests/app/page-navigation.test.tsx`

- [ ] **Step 1: Write the failing app test**

Add a test that pushes `/?ticketCode={ticketShortCode(ticket.id)}` into browser history, renders `HomePage`, and verifies it fetches `/api/tickets/ticket-1`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/app/page-navigation.test.tsx --run`

Expected: FAIL because `HomePage` ignores `ticketCode`.

- [ ] **Step 3: Implement route and client selection**

Create `src/app/t/[code]/page.tsx` with `redirect("/?ticketCode=...")`. Update `HomePage` to resolve `ticketId` or `ticketCode` from `window.location.href` after data loads.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/app/page-navigation.test.tsx --run`

Expected: PASS.

### Task 4: Startup Script Public URL File

**Files:**
- Modify: `start-external.ps1`
- Modify: `deploy/windows/app.env.sample.ps1`

- [ ] **Step 1: Update script**

Add `$PublicBaseUrlFile = Join-Path $Root "data\public-base-url.txt"`, remove it during startup, and write `$publicUrl` after Cloudflare returns the tunnel URL.

- [ ] **Step 2: Update sample env**

Document `$env:APP_PUBLIC_BASE_URL = "https://your-domain.example"` as the fixed-domain override.

- [ ] **Step 3: Smoke-check syntax**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -Command "$null = [scriptblock]::Create((Get-Content -Raw -LiteralPath '.\start-external.ps1')); 'syntax ok'"`

Expected: prints `syntax ok`.

### Task 5: Verification

- [ ] **Step 1: Run targeted tests**

Run: `npm test -- tests/domain/ticket-links.test.ts tests/services/wechat-watchtower-service.test.ts tests/app/page-navigation.test.tsx --run`

Expected: PASS.

- [ ] **Step 2: Run TypeScript check or full tests**

Run the broadest practical project verification available in the workspace.

Expected: no failures in the changed behavior area.

## Self-Review

- The plan covers receipt text, internal short links, temporary public URL sourcing, future fixed-domain override, and mobile deep linking.
- There are no database schema steps because short codes are deterministic.
- The service does not depend on HTTP request host, so local bridge URLs cannot leak into WeChat receipts.
