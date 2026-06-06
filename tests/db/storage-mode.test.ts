import { describe, expect, it } from "vitest";
import { resolveStorageMode } from "@/lib/db/storage-mode";

describe("storage mode", () => {
  it("uses JSON file storage in development when a database URL is not configured", () => {
    expect(resolveStorageMode({ NODE_ENV: "development" })).toBe("file");
  });

  it("always uses MariaDB when a database URL is configured", () => {
    expect(resolveStorageMode({
      DATABASE_URL: "mysql://board:secret@127.0.0.1:3306/collaboration_board"
    })).toBe("mariadb");
  });

  it("lets the explicit APP_STORAGE switch choose JSON file storage", () => {
    expect(resolveStorageMode({
      APP_STORAGE: "file"
    })).toBe("file");
  });
});
