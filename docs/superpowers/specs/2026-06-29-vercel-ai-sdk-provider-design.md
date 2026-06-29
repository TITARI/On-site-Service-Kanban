# Vercel AI SDK HTTP Provider Design

## Goal

Replace the hand-written OpenAI-compatible HTTP and JSON parsing layer with the current Vercel AI SDK while preserving the existing `AiProvider` interface, routing, configurable prompts, fallback behavior, SSRF validation, and mock provider.

## Dependencies and API version

- Pin `ai@7.0.4` and `@ai-sdk/openai-compatible@3.0.1`, matching the repository's exact-version dependency policy.
- Declare Node.js 22 as the project minimum because both pinned SDK packages require Node 22; update the existing installation and Windows deployment guidance from Node 20 to Node 22.
- Use `generateText` with `Output.json()`, followed immediately by the scenario's Zod `schema.parse`. This keeps the SDK's JSON parsing while avoiding provider-native JSON Schema requirements and validates the same typed application contract.
- Do not pin the legacy AI SDK solely to retain `generateObject`.
- Use Zod 4 already present in the project.

References:

- <https://ai-sdk.dev/docs/reference/ai-sdk-core/output>
- <https://ai-sdk.dev/providers/openai-compatible-providers>

## Provider construction

`http-provider.ts` remains the only adapter between the application `AiProvider` contract and the Vercel AI SDK.

For every call it will:

1. Validate the configured endpoint with the existing `validateAiEndpoint` SSRF guard.
2. Convert a stored full chat-completions URL into the base URL required by `createOpenAICompatible`. A single trailing `/chat/completions` segment is removed; endpoints already expressed as a base URL are left intact. URL query parameters are forwarded through the provider's `queryParams` option.
3. Resolve credentials with the existing precedence: `model.apiKey` first, then the allow-listed `model.apiKeyEnv`. A missing resolved key is an error.
4. Create an OpenAI-compatible provider named `configured-ai`, with `supportsStructuredOutputs: false` for broad compatibility with the configured DeepSeek, OpenAI, Qwen, Kimi, Zhipu, Ark, and custom endpoints. `Output.json()` requests generic JSON mode without emitting the warning that `Output.object()` produces when native structured outputs are disabled; the adapter then validates the parsed JSON against the local Zod schema.
5. Call `generateText` with `temperature: 0`, `maxRetries: 2`, and `timeout` equal to a positive finite `model.timeoutMs`, otherwise 8000 milliseconds.

SDK errors are not wrapped or converted. HTTP status, response details, retry exhaustion, timeout, and invalid JSON therefore reach the existing `withFallback` boundary unchanged. Valid JSON with an invalid application shape reaches the same boundary as a Zod error.

## Structured outputs and business mapping

Each scenario gets a schema matching the existing application contract:

- `classify`: non-empty `issueType` and `confidence` from 0 through 1.
- `dedupe`: `confidence` and nullable `matchedTicketId`, defaulting an omitted ID to null. The application continues to derive `action` with `decideDeduplication`; the model does not decide workflow policy.
- `escalation`: `confidence`, non-empty `suggestion`, and nullable `matchedTicketId`, defaulting an omitted ID to null. A missing match retains the existing first-candidate fallback.
- `customer-service`: confidence, integer pressure level 1 through 5, the existing action enum, a nullable matched ticket defaulting to null, non-empty reply text, and non-empty reason.
- `exhibitor-import`: an array of mappings with the existing system-field enum, non-negative integer column index, confidence from 0 through 1, and non-empty reason.

Nullable fields are converted back to `undefined` at the application boundary. Invalid or incomplete model output throws instead of being clamped, filtered, or replaced with plausible-looking defaults; `withFallback` then invokes the existing mock provider and records `provider: "mock"`.

The router remains responsible for selecting fast versus smart models and the configured prompt template. `domain/ai-config.ts` remains the source of built-in and administrator-customizable prompts. The HTTP provider accepts the selected prompt through its existing optional parameter and uses the built-in prompt for that scenario only when called directly without one. This avoids duplicating prompt text or bypassing administrator configuration.

## Compatibility boundaries

- No changes to `router.ts`, `provider.ts`, `mock-provider.ts`, `endpoint-validation.ts`, or the public `AiProvider` and decision types.
- No circuit breaker is added. The SDK's two retries run before the existing request-level fallback; circuit breaking remains a separate task requiring an explicit policy and shared state design.
- Streaming and tool calling are capabilities of the installed SDK but are not exposed because current application callers require complete structured decisions.
- Existing endpoint presets store full `/chat/completions` URLs, so endpoint normalization is required and receives dedicated regression coverage.

## Tests and acceptance

Rewrite `tests/domain/http-ai-provider.test.ts` around mocked SDK boundaries rather than hand-written `fetch` behavior. Tests cover:

- SDK provider creation, full-endpoint normalization, query forwarding, and model selection.
- Direct-key precedence, allow-listed environment keys, missing keys, and invalid endpoints.
- `maxRetries: 2`, deterministic temperature, positive timeout, and the 8000 ms fallback for zero or invalid timeouts.
- Successful mapping for all five scenarios, including local dedupe policy and nullable IDs.
- SDK rejection and structured-output rejection propagating to the unchanged `withFallback` mock path with warning metadata.
- Configured system prompts passing through unchanged.
- Existing fetch-based integration fixtures include the OpenAI-compatible `finish_reason: "stop"` field required by the SDK response contract.

Run the focused provider, router, ticket service, and AI fallback tests first, followed by the complete test suite, production build, and `npm audit`. The audit vulnerability count must not exceed the current merged baseline of three.
