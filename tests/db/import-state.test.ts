import { describe, expect, it } from "vitest";

describe("db import stable ids", () => {
  it("does not collide for long ids with the same prefix", async () => {
    const { stableId } = await import("../../scripts/db-import-state.mjs");

    const first = stableId("feedback", "ticket-fb63d144-5279-4587-8e67-3cda23558b2f:mobile-user");
    const second = stableId("feedback", "ticket-fb63d144-5279-4587-8e67-3cda23558b2f:smoke-user-2");

    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(second.length).toBeLessThanOrEqual(64);
  });
});
