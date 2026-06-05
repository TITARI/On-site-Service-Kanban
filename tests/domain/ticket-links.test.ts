import { describe, expect, it } from "vitest";
import {
  findTicketByShortCode,
  ticketDetailPath,
  ticketDetailUrl,
  ticketShortCode
} from "@/lib/domain/ticket-links";

describe("ticket short links", () => {
  it("derives a stable short code from generated ticket ids", () => {
    expect(ticketShortCode("ticket-12345678-90ab-cdef-1234-567890abcdef")).toBe("12345678");
  });

  it("builds internal short paths and absolute public URLs", () => {
    const ticketId = "ticket-12345678-90ab-cdef-1234-567890abcdef";

    expect(ticketDetailPath(ticketId)).toBe("/t/12345678");
    expect(ticketDetailUrl(ticketId, "https://board.example.com/")).toBe("https://board.example.com/t/12345678");
  });

  it("does not build a URL when the public base URL is missing or invalid", () => {
    const ticketId = "ticket-12345678-90ab-cdef-1234-567890abcdef";

    expect(ticketDetailUrl(ticketId)).toBeUndefined();
    expect(ticketDetailUrl(ticketId, "not a url")).toBeUndefined();
  });

  it("finds a ticket by its short code", () => {
    const tickets = [
      { id: "ticket-12345678-90ab-cdef-1234-567890abcdef", title: "A01 网络" },
      { id: "ticket-87654321-90ab-cdef-1234-567890abcdef", title: "B01 电力" }
    ];

    expect(findTicketByShortCode(tickets, "12345678")).toBe(tickets[0]);
    expect(findTicketByShortCode(tickets, "87654321")).toBe(tickets[1]);
    expect(findTicketByShortCode(tickets, "missing")).toBeUndefined();
  });
});
