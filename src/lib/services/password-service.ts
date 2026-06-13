import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions
} from "node:crypto";

export const KEY_LENGTH = 64;
export const COST = 16384;
export const BLOCK_SIZE = 8;
export const PARALLELIZATION = 1;

const SALT_LENGTH = 16;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SCRYPT_OPTIONS: ScryptOptions = {
  cost: COST,
  blockSize: BLOCK_SIZE,
  parallelization: PARALLELIZATION
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

function parsePositiveSafeInteger(value: string): number | undefined {
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function decodeBase64url(value: string): Buffer | undefined {
  if (!BASE64URL_PATTERN.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 || decoded.toString("base64url") !== value) {
    return undefined;
  }
  return decoded;
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) {
    throw new Error("后台密码至少需要10位");
  }

  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveKey(password, salt, SCRYPT_OPTIONS);
  return [
    "scrypt",
    COST,
    BLOCK_SIZE,
    PARALLELIZATION,
    salt.toString("base64url"),
    key.toString("base64url")
  ].join("$");
}

export async function verifyPassword(
  password: string,
  encoded: string
): Promise<boolean> {
  try {
    const parts = encoded.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;

    const cost = parsePositiveSafeInteger(parts[1]);
    const blockSize = parsePositiveSafeInteger(parts[2]);
    const parallelization = parsePositiveSafeInteger(parts[3]);
    if (
      cost !== COST ||
      blockSize !== BLOCK_SIZE ||
      parallelization !== PARALLELIZATION
    ) {
      return false;
    }

    const salt = decodeBase64url(parts[4]);
    const expectedKey = decodeBase64url(parts[5]);
    if (!salt || !expectedKey || expectedKey.length !== KEY_LENGTH) return false;

    const actualKey = await deriveKey(password, salt, {
      cost,
      blockSize,
      parallelization
    });
    return timingSafeEqual(actualKey, expectedKey);
  } catch {
    return false;
  }
}
