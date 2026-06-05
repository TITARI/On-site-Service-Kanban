import { describe, expect, it } from "vitest";
import { decideDeduplication } from "@/lib/domain/deduplication";

describe("deduplication", () => {
  it("routes high confidence duplicate to urge", () => {
    expect(decideDeduplication(0.91)).toBe("urge");
  });

  it("routes medium confidence duplicate to manual review", () => {
    expect(decideDeduplication(0.72)).toBe("manual-review");
  });

  it("routes low confidence issue to create", () => {
    expect(decideDeduplication(0.31)).toBe("create");
  });
});
