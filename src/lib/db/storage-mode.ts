export type StorageMode = "mariadb" | "file";

type StorageEnv = {
  [key: string]: string | undefined;
  APP_STORAGE?: string;
  DATABASE_URL?: string;
  NODE_ENV?: string;
};

export function resolveStorageMode(env: StorageEnv = process.env): StorageMode {
  const explicitMode = env.APP_STORAGE?.trim().toLowerCase();
  if (explicitMode === "file" || explicitMode === "json") return "file";
  if (explicitMode === "mariadb" || explicitMode === "database") {
    if (!env.DATABASE_URL?.trim()) {
      throw new Error("DATABASE_URL is required for MariaDB storage.");
    }
    return "mariadb";
  }

  if (!env.DATABASE_URL?.trim()) {
    if (env.NODE_ENV === "production") {
      throw new Error("DATABASE_URL is required for production MariaDB storage.");
    }
    return "file";
  }

  return "mariadb";
}
