import { describe, expect, it } from "vitest";
import { formatDisplayDateTime, formatDisplayTime } from "@/lib/domain/time-format";

describe("time formatting", () => {
  const now = new Date("2026-05-22T04:00:00.000Z");

  it("formats today's time without date or year", () => {
    expect(formatDisplayTime("2026-05-22T06:32:00.000Z", now)).toBe("14:32");
  });

  it("formats non-today time with month, day and no year", () => {
    expect(formatDisplayTime("2026-05-21T08:05:00.000Z", now)).toBe("05-21 16:05");
  });

  it("formats detail date time without year", () => {
    expect(formatDisplayDateTime("2026-05-22T06:32:00.000Z")).toBe("05-22 14:32");
  });
});
