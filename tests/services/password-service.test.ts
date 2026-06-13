import { createHook } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/services/password-service";

const PASSWORD = "StrongPass123!";
const CANONICAL_SALT = Buffer.alloc(16, 1).toString("base64url");
const CANONICAL_KEY = Buffer.alloc(64, 2).toString("base64url");

function encodedHash(saltText = CANONICAL_SALT, keyText = CANONICAL_KEY) {
  return `scrypt$16384$8$1$${saltText}$${keyText}`;
}

function makeNoncanonical(value: string) {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const lastIndex = alphabet.indexOf(value.at(-1) ?? "");
  return `${value.slice(0, -1)}${alphabet[lastIndex + 1]}`;
}

describe("password service", () => {
  it("uses a fresh salt for every password hash", async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);

    expect(first).not.toBe(second);
    expect(first).not.toContain(PASSWORD);
    expect(second).not.toContain(PASSWORD);
  });

  it("uses the canonical scrypt format and byte lengths", async () => {
    const encoded = await hashPassword(PASSWORD);
    const parts = encoded.split("$");

    expect(parts).toHaveLength(6);
    expect(parts.slice(0, 4)).toEqual(["scrypt", "16384", "8", "1"]);
    expect(Buffer.from(parts[4], "base64url")).toHaveLength(16);
    expect(Buffer.from(parts[5], "base64url")).toHaveLength(64);
  });

  it("verifies the correct password and rejects a wrong password", async () => {
    const encoded = await hashPassword(PASSWORD);

    await expect(verifyPassword(PASSWORD, encoded)).resolves.toBe(true);
    await expect(verifyPassword("WrongPass123!", encoded)).resolves.toBe(false);
  });

  it("rejects passwords shorter than ten characters", async () => {
    await expect(hashPassword("Short123!")).rejects.toThrow("后台密码至少需要10位");
  });

  it.each([
    ["empty input", ""],
    ["non-hash text", "not-a-password-hash"],
    ["unsupported algorithm", encodedHash().replace("scrypt", "argon2")],
    ["non-numeric cost", encodedHash().replace("16384", "NaN")],
    ["zero cost", encodedHash().replace("16384", "0")],
    [
      "unsafe integer cost",
      encodedHash().replace("16384", "9007199254740992")
    ],
    ["unsupported cost", encodedHash().replace("16384", "32768")],
    ["oversized salt text", encodedHash("A".repeat(5_000))],
    ["oversized key text", encodedHash(CANONICAL_SALT, "A".repeat(5_000))],
    [
      "under-sized decoded salt",
      encodedHash(Buffer.alloc(15).toString("base64url"))
    ],
    [
      "over-sized decoded salt",
      encodedHash(Buffer.alloc(17).toString("base64url"))
    ],
    [
      "under-sized decoded key",
      encodedHash(CANONICAL_SALT, Buffer.alloc(63).toString("base64url"))
    ],
    [
      "over-sized decoded key",
      encodedHash(CANONICAL_SALT, Buffer.alloc(65).toString("base64url"))
    ],
    ["extra fields", `${encodedHash()}$extra`],
    ["invalid salt characters", encodedHash(`${CANONICAL_SALT.slice(0, -1)}+`)],
    [
      "invalid key characters",
      encodedHash(CANONICAL_SALT, `${CANONICAL_KEY.slice(0, -1)}/`)
    ],
    ["noncanonical salt encoding", encodedHash(makeNoncanonical(CANONICAL_SALT))],
    [
      "noncanonical key encoding",
      encodedHash(CANONICAL_SALT, makeNoncanonical(CANONICAL_KEY))
    ]
  ])("rejects %s before deriving a key", async (_description, encoded) => {
    let scryptRequests = 0;
    const hook = createHook({
      init(_asyncId, type) {
        if (type === "SCRYPTREQUEST") scryptRequests += 1;
      }
    });

    hook.enable();
    try {
      await expect(verifyPassword(PASSWORD, encoded)).resolves.toBe(false);
    } finally {
      hook.disable();
    }

    expect(scryptRequests).toBe(0);
  });
});
