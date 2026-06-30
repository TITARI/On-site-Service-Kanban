import { createHook } from "node:async_hooks";
import { scryptSync } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { describe, expect, it, vi } from "vitest";
import {
  hashPassword,
  needsRehash,
  verifyPassword
} from "@/lib/services/password-service";

const PASSWORD = "StrongPass123!";
const MAX_PASSWORD_BYTES = 1024;
const CANONICAL_SALT = Buffer.alloc(16, 1).toString("base64url");
const CANONICAL_KEY = Buffer.alloc(64, 2).toString("base64url");

function encodedHash(saltText = CANONICAL_SALT, keyText = CANONICAL_KEY) {
  return `scrypt$16384$8$1$${saltText}$${keyText}`;
}

function legacyHash(password: string) {
  const salt = Buffer.alloc(16, 1);
  const key = scryptSync(password, salt, 64, {
    cost: 16384,
    blockSize: 8,
    parallelization: 1
  });
  return encodedHash(salt.toString("base64url"), key.toString("base64url"));
}

function makeNoncanonical(value: string) {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const lastIndex = alphabet.indexOf(value.at(-1) ?? "");
  return `${value.slice(0, -1)}${alphabet[lastIndex + 1]}`;
}

async function countScryptRequests(
  operation: () => Promise<void>
): Promise<number> {
  let scryptRequests = 0;
  const hook = createHook({
    init(_asyncId, type) {
      if (type === "SCRYPTREQUEST") scryptRequests += 1;
    }
  });

  hook.enable();
  try {
    await operation();
  } finally {
    hook.disable();
  }

  return scryptRequests;
}

describe("password service", () => {
  it("uses a fresh salt for every password hash", async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);

    expect(first).not.toBe(second);
    expect(first).not.toContain(PASSWORD);
    expect(second).not.toContain(PASSWORD);
  });

  it("uses the OWASP Argon2id parameters in PHC format", async () => {
    const encoded = await hashPassword(PASSWORD);

    expect(encoded).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/
    );
  });

  it("verifies the correct password and rejects a wrong password", async () => {
    const encoded = await hashPassword(PASSWORD);

    await expect(verifyPassword(PASSWORD, encoded)).resolves.toBe(true);
    await expect(verifyPassword("WrongPass123!", encoded)).resolves.toBe(false);
  });

  it("verifies canonical legacy scrypt hashes for transparent migration", async () => {
    const encoded = legacyHash(PASSWORD);

    await expect(verifyPassword(PASSWORD, encoded)).resolves.toBe(true);
    await expect(verifyPassword("WrongPass123!", encoded)).resolves.toBe(false);
  });

  it("rehashes only legacy scrypt credentials", async () => {
    const argon2id = await hashPassword(PASSWORD);

    expect(needsRehash(legacyHash(PASSWORD))).toBe(true);
    expect(needsRehash(argon2id)).toBe(false);
    expect(needsRehash("not-a-password-hash")).toBe(false);
  });

  it("rejects passwords shorter than ten characters", async () => {
    await expect(hashPassword("Short123!")).rejects.toThrow("后台密码至少需要10位");
  });

  it("rejects an oversized multibyte password before hashing", async () => {
    const password = "密".repeat(342);

    expect(password.length).toBeLessThan(MAX_PASSWORD_BYTES);
    expect(Buffer.byteLength(password, "utf8")).toBeGreaterThan(
      MAX_PASSWORD_BYTES
    );

    await expect(hashPassword(password)).rejects.toThrow(
      "后台密码不能超过1024字节"
    );
  });

  it("rejects an oversized authentication password before deriving a key", async () => {
    const password = "密".repeat(342);

    expect(password.length).toBeLessThan(MAX_PASSWORD_BYTES);
    expect(Buffer.byteLength(password, "utf8")).toBeGreaterThan(
      MAX_PASSWORD_BYTES
    );

    const scryptRequests = await countScryptRequests(async () => {
      await expect(verifyPassword(password, encodedHash())).resolves.toBe(false);
    });

    expect(scryptRequests).toBe(0);
  });

  it.each([
    ["empty input", ""],
    ["non-hash text", "not-a-password-hash"],
    ["unsupported algorithm", encodedHash().replace("scrypt", "argon2")],
    ["malformed argon2id PHC", "$argon2id$broken"],
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
    const scryptRequests = await countScryptRequests(async () => {
      await expect(verifyPassword(PASSWORD, encoded)).resolves.toBe(false);
    });

    expect(scryptRequests).toBe(0);
  });

  it("propagates an operational scrypt failure for a canonical hash", async () => {
    const failure = new Error("scrypt unavailable");
    const scrypt = vi.fn((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: Error,
        derivedKey: Buffer
      ) => void;
      queueMicrotask(() => callback(failure, Buffer.alloc(0)));
    });
    const crypto = createRequire(import.meta.url)("node:crypto") as {
      scrypt: typeof import("node:crypto").scrypt;
    };
    const originalScrypt = crypto.scrypt;

    crypto.scrypt = scrypt as unknown as typeof crypto.scrypt;
    syncBuiltinESMExports();
    vi.resetModules();
    try {
      const { verifyPassword: verifyWithFailingScrypt } =
        await import("@/lib/services/password-service");

      await expect(
        verifyWithFailingScrypt(PASSWORD, encodedHash())
      ).rejects.toBe(failure);
      expect(scrypt).toHaveBeenCalledOnce();
    } finally {
      crypto.scrypt = originalScrypt;
      syncBuiltinESMExports();
      vi.resetModules();
    }
  });
});
