import { describe, expect, it } from "vitest";
import { permissionCodesForGroup } from "@/lib/domain/access-control";

describe("permissionCodesForGroup", () => {
  it("maps fixed group flags to stable permission codes", () => {
    expect(permissionCodesForGroup({
      id: "ops",
      name: "运营组",
      description: "",
      canClaim: true,
      canProcess: false,
      canAccept: true,
      canAdmin: true,
      enabled: true
    })).toEqual(["ticket.claim", "ticket.accept", "admin.access"]);
  });
});
