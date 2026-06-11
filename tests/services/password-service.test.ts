import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/services/password-service";

describe("password service", () => {
  it("hashes with fixed scrypt parameters, a random salt, and no plaintext", async () => {
    const first = await hashPassword("StrongPass123!");
    const second = await hashPassword("StrongPass123!");
    const [algorithm, cost, blockSize, parallelization, saltText, keyText] = first.split("$");

    expect(first).not.toBe(second);
    expect(first).not.toContain("StrongPass123!");
    expect({ algorithm, cost, blockSize, parallelization }).toEqual({
      algorithm: "scrypt",
      cost: "16384",
      blockSize: "8",
      parallelization: "1"
    });
    expect(Buffer.from(saltText, "base64url")).toHaveLength(16);
    expect(Buffer.from(keyText, "base64url")).toHaveLength(64);
  });

  it("rejects backend passwords shorter than ten characters", async () => {
    await expect(hashPassword("123456789")).rejects.toThrow("后台密码至少需要10位");
  });

  it("verifies the correct password and rejects an incorrect password", async () => {
    const encoded = await hashPassword("StrongPass123!");

    await expect(verifyPassword("StrongPass123!", encoded)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password", encoded)).resolves.toBe(false);
  });

  it("safely rejects malformed stored hashes", async () => {
    const valid = await hashPassword("StrongPass123!");
    const [, , , , saltText, keyText] = valid.split("$");
    const malformed = [
      `argon2$16384$8$1$${saltText}$${keyText}`,
      "scrypt$16384$8$1",
      `scrypt$16384$8$1$${saltText}$${keyText}$extra`,
      `scrypt$not-a-number$8$1$${saltText}$${keyText}`,
      `scrypt$16384$not-a-number$1$${saltText}$${keyText}`,
      `scrypt$16384$8$not-a-number$${saltText}$${keyText}`,
      `scrypt$1073741824$8$1$${saltText}$${keyText}`,
      `scrypt$16384$1048576$1$${saltText}$${keyText}`,
      `scrypt$16384$8$1048576$${saltText}$${keyText}`,
      `scrypt$16384$8$1$not+base64url$${keyText}`,
      `scrypt$16384$8$1$${saltText}$not/base64url`,
      `scrypt$16384$8$1$${Buffer.alloc(15).toString("base64url")}$${keyText}`,
      `scrypt$16384$8$1$${saltText}$${Buffer.alloc(63).toString("base64url")}`
    ];

    await expect(Promise.all(malformed.map((encoded) => verifyPassword("StrongPass123!", encoded))))
      .resolves.toEqual(malformed.map(() => false));
  });
});
