import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const KEY_TEXT_LENGTH = 86;
const SALT_TEXT_LENGTH = 22;
const COST = 16384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const MAX_MEMORY = 32 * 1024 * 1024;
const MAX_PASSWORD_BYTES = 1024;
const MAX_ENCODED_LENGTH = "scrypt$16384$8$1$".length + SALT_TEXT_LENGTH + 1 + KEY_TEXT_LENGTH;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

const SCRYPT_OPTIONS: ScryptOptions = {
  N: COST,
  r: BLOCK_SIZE,
  p: PARALLELIZATION,
  maxmem: MAX_MEMORY
};

function deriveKey(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

function decodeBase64url(value: string, expectedLength: number) {
  if (!BASE64URL_PATTERN.test(value)) return null;

  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== expectedLength || decoded.toString("base64url") !== value) return null;
  return decoded;
}

export async function hashPassword(password: string) {
  if (password.length < 10) throw new Error("后台密码至少需要10位");
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    throw new Error("后台密码不能超过1024字节");
  }

  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveKey(password, salt);
  return [
    "scrypt",
    COST,
    BLOCK_SIZE,
    PARALLELIZATION,
    salt.toString("base64url"),
    key.toString("base64url")
  ].join("$");
}

export async function verifyPassword(password: string, encoded: string) {
  if (
    Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES
    || encoded.length > MAX_ENCODED_LENGTH
  ) {
    return false;
  }

  try {
    const parts = encoded.split("$");
    if (parts.length !== 6) return false;

    const [algorithm, cost, blockSize, parallelization, saltText, keyText] = parts;
    if (
      algorithm !== "scrypt"
      || cost !== String(COST)
      || blockSize !== String(BLOCK_SIZE)
      || parallelization !== String(PARALLELIZATION)
    ) {
      return false;
    }

    if (saltText.length !== SALT_TEXT_LENGTH || keyText.length !== KEY_TEXT_LENGTH) return false;

    const salt = decodeBase64url(saltText, SALT_LENGTH);
    const expected = decodeBase64url(keyText, KEY_LENGTH);
    if (!salt || !expected) return false;

    const actual = await deriveKey(password, salt);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
