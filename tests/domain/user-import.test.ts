import { describe, expect, it } from "vitest";
import { parseUserImportRows } from "@/lib/domain/user-import";
import type { UserGroup } from "@/lib/domain/types";

const groups: UserGroup[] = [
  {
    id: "builder",
    name: "搭建组",
    description: "",
    canClaim: true,
    canProcess: true,
    canAccept: false,
    canAdmin: false,
    enabled: true
  },
  {
    id: "disabled",
    name: "停用组",
    description: "",
    canClaim: false,
    canProcess: false,
    canAccept: false,
    canAdmin: false,
    enabled: false
  }
];

describe("user import parser", () => {
  it("normalizes the seven supported template columns", () => {
    const result = parseUserImportRows([{
      姓名: " 张三 ",
      手机号: "138 0013 8000",
      分组: "搭建组",
      分组锁定: "是",
      启用状态: "启用",
      微信账号标识: " wxid-zhang ",
      企微账号标识: " wecom-zhang "
    }], groups);

    expect(result.rows[0].normalized).toEqual({
      name: "张三",
      phone: "13800138000",
      groupId: "builder",
      groupLocked: true,
      enabled: true,
      wechatExternalUserId: "wxid-zhang",
      wecomExternalUserId: "wecom-zhang"
    });
    expect(result.rows[0].errors).toEqual([]);
  });

  it("marks invalid values and every duplicate occurrence in the file", () => {
    const result = parseUserImportRows([
      {
        姓名: "张三",
        手机号: "13800138000",
        分组: "搭建组",
        分组锁定: "否",
        启用状态: "启用",
        微信账号标识: "wxid-shared"
      },
      {
        姓名: "李四",
        手机号: "13800138000",
        分组: "停用组",
        分组锁定: "也许",
        启用状态: "未知",
        微信账号标识: "wxid-shared"
      }
    ], groups);

    expect(result.rows[0].errors).toEqual(expect.arrayContaining([
      "file-phone-duplicate",
      "file-wechat-duplicate"
    ]));
    expect(result.rows[1].errors).toEqual(expect.arrayContaining([
      "group-disabled",
      "invalid-group-locked",
      "invalid-enabled",
      "file-phone-duplicate",
      "file-wechat-duplicate"
    ]));
  });
});
