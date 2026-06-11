import { describe, expect, it } from "vitest";
import { PERMISSION_CODES, permissionCodesForGroup } from "@/lib/domain/access-control";
import type { UserGroup } from "@/lib/domain/types";

describe("permissionCodesForGroup", () => {
  const baseGroup: UserGroup = {
    id: "ops",
    name: "运营组",
    description: "",
    canClaim: false,
    canProcess: false,
    canAccept: false,
    canAdmin: false,
    enabled: true
  };

  it("publishes the complete permission catalog in stable order", () => {
    expect(PERMISSION_CODES).toEqual([
      "ticket.claim",
      "ticket.process",
      "ticket.accept",
      "admin.access"
    ]);
  });

  it.each([
    ["canClaim", "ticket.claim"],
    ["canProcess", "ticket.process"],
    ["canAccept", "ticket.accept"],
    ["canAdmin", "admin.access"]
  ] as const)("maps %s to %s", (flag, permissionCode) => {
    expect(permissionCodesForGroup({
      ...baseGroup,
      [flag]: true
    })).toEqual([permissionCode]);
  });

  it("returns enabled permissions in the same stable order", () => {
    expect(permissionCodesForGroup({
      ...baseGroup,
      canClaim: true,
      canProcess: true,
      canAccept: true,
      canAdmin: true
    })).toEqual(PERMISSION_CODES);
  });
});
