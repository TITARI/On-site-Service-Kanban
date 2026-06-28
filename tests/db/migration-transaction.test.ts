import { describe, expect, it, vi } from "vitest";
import type { DatabaseConnection } from "@/lib/db/connection";
import * as migrationHistory from "@/lib/db/migrations";

describe("deprecated migration history module", () => {
  it("reads applied versions without mutating schema state", async () => {
    const execute = vi.fn(async () => [[
      { version: "20260101000002" },
      { version: "20260101000001" }
    ]]);
    const readAppliedMigrationVersions = (
      migrationHistory as typeof migrationHistory & {
        readAppliedMigrationVersions?: (connection: DatabaseConnection) => Promise<string[]>;
      }
    ).readAppliedMigrationVersions;

    expect(readAppliedMigrationVersions).toBeTypeOf("function");
    await expect(readAppliedMigrationVersions?.({ execute } as unknown as DatabaseConnection))
      .resolves.toEqual(["20260101000001", "20260101000002"]);
    expect(execute).toHaveBeenCalledWith("SELECT version FROM schema_migrations ORDER BY version");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
