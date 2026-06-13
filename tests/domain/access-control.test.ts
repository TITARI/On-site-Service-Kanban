import { describe, expect, it } from "vitest";
import type { UserGroup } from "@/lib/domain/types";
import { PERMISSION_CODES, permissionCodesForGroup } from "@/lib/domain/access-control";

const baseGroup: UserGroup = {
  id: "group-1",
  name: "测试组",
  description: "测试权限映射",
  canClaim: false,
  canProcess: false,
  canAccept: false,
  canAdmin: false,
  enabled: true
};

describe("access control", () => {
  it("keeps permission codes in a stable order", () => {
    expect(PERMISSION_CODES).toEqual([
      "ticket.claim",
      "ticket.process",
      "ticket.accept",
      "admin.access"
    ]);

    expect(permissionCodesForGroup({
      ...baseGroup,
      canClaim: true,
      canProcess: true,
      canAccept: true,
      canAdmin: true
    })).toEqual(PERMISSION_CODES);
  });

  it.each([
    ["canClaim", "ticket.claim"],
    ["canProcess", "ticket.process"],
    ["canAccept", "ticket.accept"],
    ["canAdmin", "admin.access"]
  ] as const)("maps %s to %s", (flag, permissionCode) => {
    expect(permissionCodesForGroup({ ...baseGroup, [flag]: true })).toEqual([permissionCode]);
  });
});
