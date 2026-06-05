# UI Accessibility Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve mobile touch usability and complete the accessibility behavior of status messages, page headings, motion preferences, and the image preview dialog without changing business workflows.

**Architecture:** Keep the current component structure. Add one small `StatusMessage` component for consistent live-region semantics, extend `TicketDetail` with local dialog focus refs and keyboard trapping, and apply scoped CSS overrides for touch sizes, safe areas, reduced motion, hover feedback, and screen-reader-only headings.

**Tech Stack:** Next.js, React, TypeScript, CSS, Vitest, Testing Library

---

### Task 1: Status Message Semantics

**Files:**
- Create: `src/components/status-message.tsx`
- Create: `tests/components/status-message.test.tsx`
- Modify: `src/components/ticket-submit-form.tsx`
- Modify: `src/components/login-panel.tsx`
- Modify: `src/components/admin-shell.tsx`
- Modify: `src/components/ticket-detail.tsx`
- Modify: `src/app/page.tsx`

- [x] **Step 1: Write failing component tests**

Add tests that render `<StatusMessage tone="error">失败</StatusMessage>` and `<StatusMessage tone="status">成功</StatusMessage>`, then assert `role="alert"` for errors and `role="status"` with `aria-live="polite"` for normal status.

- [x] **Step 2: Run the focused test and confirm red**

Run: `npm.cmd run test:run -- tests/components/status-message.test.tsx`

Expected: FAIL because `@/components/status-message` does not exist.

- [x] **Step 3: Implement the minimal semantic component**

Create a component that returns:

```tsx
export function StatusMessage({ children, tone = "status" }: Props) {
  if (tone === "error") return <p className="form-message" role="alert">{children}</p>;
  return <p aria-live="polite" className="form-message" role="status">{children}</p>;
}
```

Replace existing mobile and login `.form-message` paragraphs with `StatusMessage`. Use `tone="error"` for validation and request failures, and normal status for successful replies or submissions.

- [x] **Step 4: Run focused tests**

Run: `npm.cmd run test:run -- tests/components/status-message.test.tsx tests/components/ticket-submit-form.test.tsx tests/components/ticket-detail.test.tsx tests/app/page-navigation.test.tsx tests/app/admin-page.test.tsx`

Expected: PASS.

### Task 2: Heading Semantics

**Files:**
- Modify: `tests/components/ticket-detail.test.tsx`
- Modify: `tests/components/admin-panel.test.tsx`
- Modify: `src/components/ticket-detail.tsx`
- Modify: `src/components/admin-panel.tsx`
- Modify: `src/styles/globals.css`

- [x] **Step 1: Write failing heading tests**

Assert that ticket detail exposes a level-one heading named `工单详情`, and that `AdminConfigCenter` exposes its current page title as a level-one heading.

- [x] **Step 2: Run tests and confirm red**

Run: `npm.cmd run test:run -- tests/components/ticket-detail.test.tsx tests/components/admin-panel.test.tsx`

Expected: FAIL because both pages currently start their content hierarchy at `h2`.

- [x] **Step 3: Implement headings**

Add `<h1 className="sr-only">工单详情</h1>` inside ticket detail. Change the PC admin page title from `h2` to `h1`, and update the existing CSS selector so its appearance remains unchanged.

- [x] **Step 4: Run focused tests**

Run: `npm.cmd run test:run -- tests/components/ticket-detail.test.tsx tests/components/admin-panel.test.tsx`

Expected: PASS.

### Task 3: Image Preview Focus Management

**Files:**
- Modify: `tests/components/ticket-detail.test.tsx`
- Modify: `src/components/ticket-detail.tsx`

- [x] **Step 1: Write failing keyboard-focus tests**

Extend the gallery test to assert:

```tsx
expect(closeButton).toHaveFocus();
await user.tab({ shift: true });
expect(viewer.contains(document.activeElement)).toBe(true);
await user.click(closeButton);
expect(openButton).toHaveFocus();
```

- [x] **Step 2: Run the gallery test and confirm red**

Run: `npm.cmd run test:run -- tests/components/ticket-detail.test.tsx`

Expected: FAIL because opening the viewer does not focus the close button and closing does not restore focus.

- [x] **Step 3: Implement local focus management**

Add refs for the dialog, close button, and opener button. Pass the clicked opener from `GalleryImageGrid` into `openGallery`. On open, focus the close button. On close, restore focus to the opener. Trap `Tab` and `Shift+Tab` inside enabled dialog controls while preserving existing Escape and arrow-key behavior.

- [x] **Step 4: Run the gallery test**

Run: `npm.cmd run test:run -- tests/components/ticket-detail.test.tsx`

Expected: PASS.

### Task 4: Touch, Safe Area, Hover, and Reduced Motion Styles

**Files:**
- Modify: `src/styles/globals.css`

- [x] **Step 1: Apply scoped CSS changes**

Add:

```css
button,
a {
  cursor: pointer;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}

@media (hover: hover) {
  .ticket-row:hover { transform: translateY(-1px); }
}

@media (max-width: 600px) {
  input, select, textarea { min-height: 44px; font-size: 16px; }
  .primary-button, .secondary-button, .reply-box button, .back-button { min-height: 44px; }
  .hero-user button { width: 44px; height: 44px; }
  .bottom-nav { bottom: max(14px, env(safe-area-inset-bottom)); }
  .bottom-nav button { min-height: 44px; }
  .mobile-shell { padding-bottom: calc(106px + env(safe-area-inset-bottom)); }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

Update image-viewer close and rotate controls to meet touch sizing.

- [x] **Step 2: Run production checks**

Run: `npm.cmd run test:run`

Expected: PASS.

Run: `npm.cmd run build`

Expected: PASS.

### Task 5: Browser Verification

**Files:**
- No source changes expected

- [x] **Step 1: Verify mobile board**

Open the local app, inspect the submit page and ticket detail, and confirm:

- form controls use at least `16px` text and `44px` height,
- main mobile action buttons and bottom navigation meet `44px`,
- no horizontal overflow is introduced.

- [x] **Step 2: Verify PC admin**

Open `/admin/system` and confirm the system configuration page still has no horizontal overflow and retains its compact desktop layout.

- [x] **Step 3: Report verification**

Summarize changed files and fresh test/build/browser evidence. The workspace has no `.git`, so no commit step is available.
