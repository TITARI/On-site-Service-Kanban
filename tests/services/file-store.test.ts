import { describe, expect, it, vi } from "vitest";
import { parseStoredState } from "@/lib/storage/file-store";

describe("file store", () => {
  it("throws on malformed state json instead of silently resetting data", () => {
    expect(() => parseStoredState("{ broken json")).toThrow("状态文件损坏");
  });

  it("normalizes RBAC collections and administrator flags in legacy state", () => {
    const state = parseStoredState(JSON.stringify({
      booths: [],
      tickets: [],
      config: {
        userGroups: [
          {
            id: "legacy",
            name: "旧分组",
            description: "没有管理员权限字段",
            canClaim: true,
            canProcess: false,
            canAccept: false,
            enabled: true
          }
        ]
      }
    }));

    expect(state.messageRecords).toEqual([]);
    expect(state.accounts).toEqual([]);
    expect(state.accountCredentials).toEqual([]);
    expect(state.roles).toEqual([]);
    expect(state.accountRoles).toEqual([]);
    expect(state.rolePermissions).toEqual([]);
    expect(state.accountSessions).toEqual([]);
    expect(state.authBootstrap).toBeNull();
    expect(state.config.userGroups).toEqual([
      expect.objectContaining({ id: "legacy", canAdmin: false })
    ]);
  });

  it("retries transient EPERM failures when replacing the state file", async () => {
    vi.resetModules();
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const readFile = vi.fn();
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const rename = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("locked"), { code: "EPERM" }))
      .mockResolvedValueOnce(undefined);

    vi.doMock("node:fs/promises", () => ({
      default: { mkdir, readFile, rename, writeFile },
      mkdir,
      readFile,
      rename,
      writeFile
    }));

    const { initialState, writeState } = await import("@/lib/storage/file-store");
    await writeState(initialState());

    expect(rename).toHaveBeenCalledTimes(2);
    vi.doUnmock("node:fs/promises");
  });
});
