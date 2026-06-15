import { describe, expect, it } from "vitest";
import type { AuthenticatedActor } from "@/lib/domain/access-control";
import { currentUserFromActor } from "@/lib/client/auth";

function actor(overrides: Partial<AuthenticatedActor> = {}): AuthenticatedActor {
  return {
    accountId: "account-1",
    personId: "person-1",
    name: "Alice",
    phone: "13800138000",
    groupId: "business",
    groupName: "Business",
    permissions: ["ticket.accept"],
    sessionType: "mobile",
    ...overrides
  };
}

describe("client auth helpers", () => {
  it("uses the person id, not the account id, as the current user id", () => {
    expect(currentUserFromActor(actor()).id).toBe("person-1");
  });
});
