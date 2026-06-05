# AI Provider Prompt Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the admin AI settings into provider presets plus copy-editable AI prompt presets.

**Architecture:** Add domain helpers for AI provider presets and prompt templates, extend the existing JSON-backed `AppConfig`, pass scenario prompts through the AI router/provider, and update the admin UI to expose provider recommendations and prompt-template copy/edit flows. The database remains schema-compatible because config is already stored as JSON.

**Tech Stack:** Next.js, React, TypeScript, Vitest, existing CSS/admin component patterns.

---

## File Structure

- Create: `src/lib/domain/ai-config.ts`
  - Provider presets, built-in prompt templates, config normalization, selected-template lookup, copy helpers.
- Modify: `src/lib/domain/types.ts`
  - Add AI preset/template types and optional fields on `AiModelConfig`.
- Modify: `src/lib/seed.ts`
  - Include default prompt templates/defaults in `AppConfig` and default config.
- Modify: `src/lib/db/mariadb-state-store.ts`
  - Merge missing AI prompt config from defaults when reading old JSON config.
- Modify: `src/lib/services/config-service.ts`
  - Normalize prompt templates/defaults during validation and continue stripping secrets.
- Modify: `src/lib/ai/types.ts`, `src/lib/ai/http-provider.ts`, `src/lib/ai/provider.ts`, `src/lib/ai/mock-provider.ts`, `src/lib/ai/router.ts`
  - Allow scenario-specific system prompts to flow into HTTP calls; mock provider ignores them.
- Modify: `src/lib/services/ticket-service.ts`, `src/lib/services/message-intake-service.ts`, `src/lib/services/escalation-service.ts`
  - Create AI routers with config prompt settings.
- Modify: `src/components/admin-panel.tsx`
  - Provider preset UI, “apply recommendation” action, prompt preset cards, copy/edit/default actions.
- Modify: `tests/domain/http-ai-provider.test.ts`, `tests/components/admin-panel.test.tsx`
  - Regression coverage for prompt passing and admin interactions.
- Create: `tests/domain/ai-config.test.ts`
  - Domain helper coverage.

### Task 1: Domain Types and Helpers

**Files:**
- Modify: `src/lib/domain/types.ts`
- Create: `src/lib/domain/ai-config.ts`
- Modify: `src/lib/seed.ts`
- Modify: `src/lib/db/mariadb-state-store.ts`
- Modify: `src/lib/services/config-service.ts`
- Test: `tests/domain/ai-config.test.ts`

- [ ] **Step 1: Write failing tests**

Create tests proving provider presets return DeepSeek/OpenAI recommendations, default templates cover `classify`/`dedupe`/`escalation`, old configs normalize to defaults, and built-ins can be copied into editable custom templates.

- [ ] **Step 2: Verify red**

Run: `npm.cmd test -- tests/domain/ai-config.test.ts --run`

Expected: FAIL because `@/lib/domain/ai-config` does not exist.

- [ ] **Step 3: Implement helpers and config extension**

Add types, default templates/defaults, and merge/validation support. Keep all new fields optional for old config compatibility.

- [ ] **Step 4: Verify green**

Run: `npm.cmd test -- tests/domain/ai-config.test.ts --run`

Expected: PASS.

### Task 2: Prompt Templates in AI Calls

**Files:**
- Modify: `src/lib/ai/types.ts`
- Modify: `src/lib/ai/http-provider.ts`
- Modify: `src/lib/ai/provider.ts`
- Modify: `src/lib/ai/mock-provider.ts`
- Modify: `src/lib/ai/router.ts`
- Modify: `src/lib/services/ticket-service.ts`
- Modify: `src/lib/services/message-intake-service.ts`
- Modify: `src/lib/services/escalation-service.ts`
- Test: `tests/domain/http-ai-provider.test.ts`

- [ ] **Step 1: Write failing test**

Add a test that calls the configured provider with a custom classification system prompt and asserts the outgoing `messages[0].content` uses it.

- [ ] **Step 2: Verify red**

Run: `npm.cmd test -- tests/domain/http-ai-provider.test.ts --run`

Expected: FAIL because the HTTP provider uses hard-coded system prompts.

- [ ] **Step 3: Implement prompt plumbing**

Allow provider methods to accept optional `systemPrompt`, update HTTP provider fallbacks, and have `createAiRouter` select prompts by scenario from config.

- [ ] **Step 4: Verify green**

Run: `npm.cmd test -- tests/domain/http-ai-provider.test.ts --run`

Expected: PASS.

### Task 3: Admin Provider Preset UI

**Files:**
- Modify: `src/components/admin-panel.tsx`
- Test: `tests/components/admin-panel.test.tsx`

- [ ] **Step 1: Write failing test**

Add a test that selects DeepSeek for 快速AI, clicks “应用快速AI供应商推荐值”, saves, and asserts `providerPreset`, endpoint, model name, key env, timeout, and provider are saved.

- [ ] **Step 2: Verify red**

Run: `npm.cmd test -- tests/components/admin-panel.test.tsx --run`

Expected: FAIL because the provider preset selector/action is not rendered.

- [ ] **Step 3: Implement provider preset UI**

Render provider preset selector, recommendation copy, apply button, and save `providerPreset` alongside existing AI model fields.

- [ ] **Step 4: Verify green**

Run: `npm.cmd test -- tests/components/admin-panel.test.tsx --run`

Expected: PASS.

### Task 4: Admin Prompt Template UI

**Files:**
- Modify: `src/components/admin-panel.tsx`
- Test: `tests/components/admin-panel.test.tsx`

- [ ] **Step 1: Write failing tests**

Add tests for rendering the three prompt scenarios, copying the built-in 分类 template to a custom template, editing the custom template, and setting it as the scenario default.

- [ ] **Step 2: Verify red**

Run: `npm.cmd test -- tests/components/admin-panel.test.tsx --run`

Expected: FAIL because prompt template cards are not rendered.

- [ ] **Step 3: Implement prompt-template forms**

Render prompt template cards with built-in read-only cards and editable custom cards. Save through the existing `/api/admin/config` path.

- [ ] **Step 4: Verify green**

Run: `npm.cmd test -- tests/components/admin-panel.test.tsx --run`

Expected: PASS.

### Task 5: Verification

- [ ] **Step 1: Run targeted tests**

Run: `npm.cmd test -- tests/domain/ai-config.test.ts tests/domain/http-ai-provider.test.ts tests/components/admin-panel.test.tsx --run`

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run: `npm.cmd test -- --run`

Expected: PASS, ignoring existing jsdom canvas “not implemented” notices if they remain warnings.

- [ ] **Step 3: Browser smoke**

Open `http://127.0.0.1:3001/admin/system` in the running dev server and verify the AI section renders without a 500.

## Self-Review

- The plan covers the confirmed “copy preset before editing” flow.
- Database schema changes are not needed because app config already persists JSON and the dedicated relational AI config rows are rebuilt from normalized config.
- The prompt plumbing preserves existing fallback behavior and only changes HTTP system prompts when templates are configured.
