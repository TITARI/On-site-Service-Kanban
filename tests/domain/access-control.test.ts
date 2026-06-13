import { readFileSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import type { UserGroup } from "@/lib/domain/types";
import { PERMISSION_CODES, permissionCodesForGroup } from "@/lib/domain/access-control";
import type {
  Account,
  AccountRole,
  AccountSession,
  Role,
  RolePermission,
  SessionResolution
} from "@/lib/domain/access-control";

const accessControlSource = readFileSync(
  path.join(process.cwd(), "src", "lib", "domain", "access-control.ts"),
  "utf-8"
);
const accessControlSourceFile = ts.createSourceFile(
  "access-control.ts",
  accessControlSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
);

function normalizeTypeSyntax(typeText: string) {
  return typeText
    .replace(/\s+/g, "")
    .replace(/:\|/g, ":")
    .replace(/;}/g, "}");
}

function normalizedTypeText(typeName: string) {
  const declaration = accessControlSourceFile.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === typeName
  );
  if (!declaration) return "";
  return normalizeTypeSyntax(declaration.type.getText(accessControlSourceFile));
}

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

const accountFixture = {
  id: "account-person-1",
  personId: "person-1",
  loginName: "13800138000",
  enabled: true,
  authVersion: 1,
  createdAt: "2026-06-13T00:00:00.000Z",
  updatedAt: "2026-06-13T00:00:00.000Z"
} satisfies Account;

const roleFixture = {
  id: "role-builder",
  name: "搭建组",
  sourceGroupId: "builder",
  enabled: true,
  createdAt: "2026-06-13T00:00:00.000Z",
  updatedAt: "2026-06-13T00:00:00.000Z"
} satisfies Role;

const accountRoleFixture = {
  accountId: accountFixture.id,
  roleId: roleFixture.id,
  createdAt: "2026-06-13T00:00:00.000Z"
} satisfies AccountRole;

const rolePermissionFixture = {
  roleId: roleFixture.id,
  permissionCode: "ticket.process",
  createdAt: "2026-06-13T00:00:00.000Z"
} satisfies RolePermission;

const accountSessionFixture = {
  id: "session-1",
  accountId: accountFixture.id,
  sessionType: "mobile",
  tokenHash: "token-hash",
  authVersion: 1,
  expiresAt: "2026-06-14T00:00:00.000Z",
  lastSeenAt: "2026-06-13T00:00:00.000Z",
  createdAt: "2026-06-13T00:00:00.000Z"
} satisfies AccountSession;

const sessionResolutionFixture = {
  session: accountSessionFixture,
  actor: {
    accountId: accountFixture.id,
    personId: accountFixture.personId,
    name: "测试用户",
    phone: accountFixture.loginName,
    groupId: roleFixture.sourceGroupId,
    groupName: roleFixture.name,
    permissions: [rolePermissionFixture.permissionCode],
    sessionType: accountSessionFixture.sessionType
  }
} satisfies SessionResolution;

describe("access control", () => {
  it.each([
    ["SessionType", `"mobile"|"admin"`],
    [
      "AccountCredential",
      "{accountId:string;passwordHash:string;passwordChangedAt:string;mustChangePassword:boolean;failedAttempts:number;lockedUntil?:string;}"
    ],
    [
      "AuthenticatedActor",
      "{accountId:string;personId:string;name:string;phone:string;groupId:string;groupName:string;permissions:PermissionCode[];sessionType:SessionType;}"
    ],
    ["MobileAccountInput", "{name:string;phone:string;groupId:string;}"],
    ["UserMutation", "{name:string;phone:string;groupId:string;groupLocked:boolean;enabled:boolean;}"],
    [
      "BootstrapAdminInput",
      `{legacyPassword:string;name:string;phone:string;password:string;group:{mode:"existing";groupId:string}|{mode:"create";name:string};}`
    ],
    [
      "UserQuery",
      `{search?:string;groupId?:string;enabled?:boolean;admin?:boolean;binding?:"bound"|"unbound";page:number;pageSize:number;}`
    ],
    ["AdminLoginRecord", "{actor:AuthenticatedActor;credential:AccountCredential;}"],
    ["AuthBootstrapState", "{completedAt?:string;completedByAccountId?:string;}"],
    [
      "UserListItem",
      "{personId:string;accountId:string;name:string;phone:string;groupId:string;groupName:string;groupLocked:boolean;enabled:boolean;permissions:PermissionCode[];hasPassword:boolean;lastLoginAt?:string;identities:Partial<Record<MessageChannel,{id:string;externalUserId:string;displayName:string}>>;updatedAt:string;}"
    ]
  ])("keeps the exact %s contract", (typeName, expectedType) => {
    expect(normalizedTypeText(typeName)).toBe(normalizeTypeSyntax(expectedType));
  });

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
