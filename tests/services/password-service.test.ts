import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/services/password-service";

describe("password service", () => {
  it("uses a fresh salt for every password hash", async () => {
    const first = await hashPassword("StrongPass123!");
    const second = await hashPassword("StrongPass123!");

    expect(first).not.toBe(second);
    expect(first).not.toContain("StrongPass123!");
    expect(second).not.toContain("StrongPass123!");
  });

  it("verifies the correct password and rejects a wrong password", async () => {
    const encoded = await hashPassword("StrongPass123!");

    await expect(verifyPassword("StrongPass123!", encoded)).resolves.toBe(true);
    await expect(verifyPassword("WrongPass123!", encoded)).resolves.toBe(false);
  });

  it("rejects passwords shorter than ten characters", async () => {
    await expect(hashPassword("Short123!")).rejects.toThrow("后台密码至少需要10位");
  });

  it.each([
    "",
    "not-a-password-hash",
    "argon2$16384$8$1$c2FsdA$a2V5",
    "scrypt$NaN$8$1$c2FsdA$a2V5",
    "scrypt$0$8$1$c2FsdA$a2V5",
    "scrypt$9007199254740992$8$1$c2FsdA$a2V5",
    "scrypt$32768$8$1$c2FsdA$a2V5",
    "scrypt$16384$8$1$not+base64url$a2V5",
    "scrypt$16384$8$1$c2FsdA$not/base64url"
  ])("returns false for malformed or unsupported hash %j", async (encoded) => {
    await expect(verifyPassword("StrongPass123!", encoded)).resolves.toBe(false);
  });
});
