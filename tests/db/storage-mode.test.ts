import { describe, expect, it } from "vitest";
import { resolveStorageMode } from "@/lib/db/storage-mode";

describe("storage mode", () => {
  it("requires a database URL", () => {
    expect(() => resolveStorageMode({})).toThrow("DATABASE_URL");
  });

  it("always uses MariaDB when a database URL is configured", () => {
    expect(resolveStorageMode({
      DATABASE_URL: "mysql://board:secret@127.0.0.1:3306/collaboration_board"
    })).toBe("mariadb");
  });

  it("ignores the removed APP_STORAGE switch", () => {
    expect(resolveStorageMode({
      APP_STORAGE: "file",
      DATABASE_URL: "mysql://board:secret@127.0.0.1:3306/collaboration_board"
    })).toBe("mariadb");
  });
});
