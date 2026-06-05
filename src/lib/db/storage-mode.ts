export type StorageMode = "mariadb";

type StorageEnv = {
  [key: string]: string | undefined;
  DATABASE_URL?: string;
};

export function resolveStorageMode(env: StorageEnv = process.env): StorageMode {
  if (!env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL is required. File storage mode has been removed.");
  }
  return "mariadb";
}
