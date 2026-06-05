import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  redirect: redirectMock
}));

describe("ticket short route", () => {
  it("redirects short links into the mobile ticket code query", async () => {
    const { default: TicketShortLinkPage } = await import("@/app/t/[code]/page");

    await TicketShortLinkPage({ params: Promise.resolve({ code: "12345678" }) });

    expect(redirectMock).toHaveBeenCalledWith("/?ticketCode=12345678");
  });
});
