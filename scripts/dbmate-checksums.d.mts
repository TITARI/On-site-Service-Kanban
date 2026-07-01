export interface MigrationChecksumManifest {
  algorithm: "sha256";
  files: Record<string, string>;
}

export function sealMigrations(
  migrationsDir?: string
): Promise<MigrationChecksumManifest>;

export function verifyMigrations(
  migrationsDir?: string
): Promise<{ count: number }>;
