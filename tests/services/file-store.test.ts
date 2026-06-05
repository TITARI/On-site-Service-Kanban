import { describe, expect, it, vi } from "vitest";
import { parseStoredState } from "@/lib/storage/file-store";

describe("file store", () => {
  it("throws on malformed state json instead of silently resetting data", () => {
    expect(() => parseStoredState("{ broken json")).toThrow("状态文件损坏");
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
