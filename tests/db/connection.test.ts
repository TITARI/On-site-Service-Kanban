import { describe, expect, it, vi } from "vitest";

describe("database connection", () => {
  it("uses utf8mb4 for MariaDB client connections", async () => {
    const createPool = vi.fn(() => ({ end: vi.fn() }));
    vi.doMock("mysql2/promise", () => ({
      default: { createPool }
    }));
    vi.resetModules();

    const { createDatabasePool } = await import("@/lib/db/connection");
    createDatabasePool("mysql://board:secret@127.0.0.1:3306/collaboration_board");

    expect(createPool).toHaveBeenCalledWith(expect.objectContaining({
      charset: "utf8mb4_unicode_ci"
    }));
  });
});
