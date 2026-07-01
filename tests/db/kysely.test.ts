import { afterEach, describe, expect, it, vi } from "vitest";

describe("Kysely database client", () => {
  afterEach(async () => {
    const { closeKysely } = await import("@/lib/db/kysely");
    await closeKysely();
    vi.unstubAllEnvs();
  });

  it("compiles a typed ticket query with the MySQL dialect", async () => {
    const { createKysely } = await import("@/lib/db/kysely");
    const db = createKysely("mysql://board:secret@127.0.0.1:3306/collaboration_board");

    const query = db
      .selectFrom("tickets")
      .select(["id", "booth_number"])
      .where("booth_number", "=", "A-101")
      .where("status", "!=", "closed")
      .orderBy("created_at", "asc")
      .compile();

    expect(query.sql).toBe(
      "select `id`, `booth_number` from `tickets` where `booth_number` = ? and `status` != ? order by `created_at` asc"
    );
    expect(query.parameters).toEqual(["A-101", "closed"]);

    await db.destroy();
  });

  it("reuses one lazy client until it is closed", async () => {
    const { closeKysely, getKysely } = await import("@/lib/db/kysely");
    vi.stubEnv("DATABASE_URL", "mysql://board:secret@127.0.0.1:3306/collaboration_board");

    const first = getKysely();
    const second = getKysely();
    expect(second).toBe(first);

    await closeKysely();

    const replacement = getKysely();
    expect(replacement).not.toBe(first);
  });
});
