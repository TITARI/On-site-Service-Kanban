import { describe, expect, it } from "vitest";
import { DEDUPLICATION_THRESHOLDS, decideDeduplication } from "@/lib/domain/deduplication";

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

  it("treats the urge threshold as inclusive", () => {
    expect(decideDeduplication(DEDUPLICATION_THRESHOLDS.urge)).toBe("urge");
  });

  it("routes confidence just below the urge threshold to manual review", () => {
    expect(decideDeduplication(DEDUPLICATION_THRESHOLDS.urge - 0.0001)).toBe("manual-review");
  });

  it("treats the manual-review threshold as inclusive", () => {
    expect(decideDeduplication(DEDUPLICATION_THRESHOLDS.manualReview)).toBe("manual-review");
  });

  it("routes confidence just below the manual-review threshold to create", () => {
    expect(decideDeduplication(DEDUPLICATION_THRESHOLDS.manualReview - 0.0001)).toBe("create");
  });

  it("handles the extreme confidence bounds", () => {
    expect(decideDeduplication(1)).toBe("urge");
    expect(decideDeduplication(0)).toBe("create");
  });
});
