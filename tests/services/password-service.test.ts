import { describe, expect, it, vi } from "vitest";
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

  it("rejects passwords longer than 1024 UTF-8 bytes", async () => {
    const oversizedPassword = "密".repeat(342);

    await expect(hashPassword(oversizedPassword)).rejects.toThrow("后台密码不能超过1024字节");
  });

  it("verifies the correct password and rejects an incorrect password", async () => {
    const encoded = await hashPassword("StrongPass123!");

    await expect(verifyPassword("StrongPass123!", encoded)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password", encoded)).resolves.toBe(false);
    await expect(verifyPassword("密".repeat(342), encoded)).resolves.toBe(false);
  });

  it("rejects oversized stored hashes before base64url decoding", async () => {
    const valid = await hashPassword("StrongPass123!");
    const [, , , , , keyText] = valid.split("$");
    const fromSpy = vi.spyOn(Buffer, "from");

    try {
      await expect(
        verifyPassword("StrongPass123!", `scrypt$16384$8$1$${"A".repeat(10_000)}$${keyText}`)
      ).resolves.toBe(false);
      expect(fromSpy).not.toHaveBeenCalled();
    } finally {
      fromSpy.mockRestore();
    }
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
      `scrypt$16384$8$1$${"A".repeat(23)}$${keyText}`,
      `scrypt$16384$8$1$${saltText}$${"A".repeat(87)}`,
      `scrypt$16384$8$1$${Buffer.alloc(15).toString("base64url")}$${keyText}`,
      `scrypt$16384$8$1$${saltText}$${Buffer.alloc(63).toString("base64url")}`
    ];

    await expect(Promise.all(malformed.map((encoded) => verifyPassword("StrongPass123!", encoded))))
      .resolves.toEqual(malformed.map(() => false));
  });
});
