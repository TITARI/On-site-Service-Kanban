import {
  hash as argon2Hash,
  verify as argon2Verify,
  type Algorithm,
  type Options as Argon2Options
} from "@node-rs/argon2";
import {
  scrypt,
  timingSafeEqual,
  type ScryptOptions
} from "node:crypto";

export const PASSWORD_MIN_LENGTH = 10;
export const KEY_LENGTH = 64;
export const COST = 16384;
export const BLOCK_SIZE = 8;
export const PARALLELIZATION = 1;

const SALT_LENGTH = 16;
const SALT_TEXT_LENGTH = 22;
const KEY_TEXT_LENGTH = 86;
const MAX_PASSWORD_BYTES = 1024;
const MAX_ARGON2_HASH_LENGTH = 512;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const HASH_PARAMETER_PREFIX = [
  "scrypt",
  COST,
  BLOCK_SIZE,
  PARALLELIZATION
].join("$");
const MAX_ENCODED_LENGTH =
  HASH_PARAMETER_PREFIX.length +
  1 +
  SALT_TEXT_LENGTH +
  1 +
  KEY_TEXT_LENGTH;
const SCRYPT_OPTIONS: ScryptOptions = {
  cost: COST,
  blockSize: BLOCK_SIZE,
  parallelization: PARALLELIZATION
};
const ARGON2_OPTIONS: Argon2Options = {
  // @node-rs/argon2 declares Algorithm as an ambient const enum, which
  // isolatedModules cannot access by member name. Runtime Argon2id is 2.
  algorithm: 2 as Algorithm,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1
};

function deriveKey(
  password: string,
  salt: Buffer,
  options: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

function decodeBase64url(
  value: string,
  encodedLength: number,
  decodedLength: number
): Buffer | undefined {
  if (
    value.length !== encodedLength ||
    !BASE64URL_PATTERN.test(value)
  ) {
    return undefined;
  }

  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length !== decodedLength ||
    decoded.toString("base64url") !== value
  ) {
    return undefined;
  }
  return decoded;
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`后台密码至少需要${PASSWORD_MIN_LENGTH}位`);
  }
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    throw new Error("后台密码不能超过1024字节");
  }

  return argon2Hash(password, ARGON2_OPTIONS);
}

function legacyScryptParts(encoded: string) {
  if (encoded.length > MAX_ENCODED_LENGTH) return false;

  const parts = encoded.split("$");
  if (
    parts.length !== 6 ||
    parts[0] !== "scrypt" ||
    parts[1] !== String(COST) ||
    parts[2] !== String(BLOCK_SIZE) ||
    parts[3] !== String(PARALLELIZATION)
  ) {
    return false;
  }

  const salt = decodeBase64url(parts[4], SALT_TEXT_LENGTH, SALT_LENGTH);
  const expectedKey = decodeBase64url(
    parts[5],
    KEY_TEXT_LENGTH,
    KEY_LENGTH
  );
  if (!salt || !expectedKey) return false;
  return { salt, expectedKey };
}

async function verifyLegacyScrypt(
  password: string,
  encoded: string
): Promise<boolean> {
  const parsed = legacyScryptParts(encoded);
  if (!parsed) return false;

  const actualKey = await deriveKey(password, parsed.salt, SCRYPT_OPTIONS);
  return timingSafeEqual(actualKey, parsed.expectedKey);
}

export async function verifyPassword(
  password: string,
  encoded: string
): Promise<boolean> {
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return false;
  if (encoded.startsWith("scrypt$")) {
    return verifyLegacyScrypt(password, encoded);
  }
  if (
    !encoded.startsWith("$argon2id$") ||
    encoded.length > MAX_ARGON2_HASH_LENGTH
  ) {
    return false;
  }

  try {
    return await argon2Verify(encoded, password);
  } catch {
    return false;
  }
}

export function needsRehash(encoded: string): boolean {
  return Boolean(legacyScryptParts(encoded));
}
