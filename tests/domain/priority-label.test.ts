import { describe, expect, it } from "vitest";
import { getPriorityDisplay } from "@/lib/domain/priority-label";

describe("priority display", () => {
  it("maps priority scores to Chinese labels and color tones", () => {
    expect(getPriorityDisplay(95)).toEqual({ label: "紧急", tone: "critical" });
    expect(getPriorityDisplay(55)).toEqual({ label: "较急", tone: "high" });
    expect(getPriorityDisplay(25)).toEqual({ label: "普通", tone: "normal" });
    expect(getPriorityDisplay(5)).toEqual({ label: "低", tone: "low" });
  });
});
