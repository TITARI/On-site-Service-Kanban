import { describe, expect, it } from "vitest";
import { canTransition, createTicketTitle, elapsedSinceAccepted } from "@/lib/domain/workflow";
import type { TicketStatus } from "@/lib/domain/types";

describe("ticket workflow", () => {
  it("allows the configured status flow", () => {
    const allowed: Array<[TicketStatus, TicketStatus]> = [
      ["待受理", "处理中"],
      ["处理中", "挂起"],
      ["挂起", "处理中"],
      ["处理中", "已解决"],
      ["已解决", "待再次处理"],
      ["待再次处理", "处理中"],
      ["待再次处理", "已解决"],
      ["待再次处理", "挂起"],
      ["已解决", "已关闭"]
    ];

    for (const [from, to] of allowed) {
      expect(canTransition(from, to)).toBe(true);
    }
  });

  it("rejects invalid status jumps", () => {
    expect(canTransition("待受理", "已关闭")).toBe(false);
    expect(canTransition("挂起", "已关闭")).toBe(false);
    expect(canTransition("待再次处理", "已关闭")).toBe(false);
  });

  it("generates title from booth number, company short name and issue type", () => {
    expect(createTicketTitle("A12", "星河科技", "网络")).toBe("A12 星河科技 网络");
  });

  it("calculates accepted elapsed minutes", () => {
    const acceptedAt = new Date("2026-05-21T08:00:00.000Z").toISOString();
    const now = new Date("2026-05-21T08:37:00.000Z").toISOString();

    expect(elapsedSinceAccepted(acceptedAt, now)).toBe(37);
    expect(elapsedSinceAccepted(undefined, now)).toBe(0);
  });
});
