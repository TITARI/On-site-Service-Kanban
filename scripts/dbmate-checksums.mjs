import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultMigrationsDir = path.join(rootDir, "db", "migrations");
const migrationNamePattern = /^(\d{14})_[a-z0-9][a-z0-9_]*\.sql$/;

function checksum(buffer) {
  const normalized = Buffer.from(buffer.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  return createHash("sha256").update(normalized).digest("hex");
}

function manifestPath(migrationsDir) {
  return path.join(migrationsDir, "checksums.json");
}

function requireDirective(sql, filename, directive) {
  const pattern = new RegExp(`^-- migrate:${directive}(?:\\s+[^\\r\\n]+)?\\r?$`, "m");
  if (!pattern.test(sql)) {
    throw new Error(`${filename}: missing -- migrate:${directive} directive`);
  }
}

async function inspectMigrations(migrationsDir) {
  const filenames = (await readdir(migrationsDir))
    .filter((filename) => filename.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));
  const versions = new Set();
  const migrations = [];

  for (const filename of filenames) {
    const match = migrationNamePattern.exec(filename);
    if (!match) throw new Error(`invalid dbmate migration filename: ${filename}`);
    const version = match[1];
    if (versions.has(version)) throw new Error(`duplicate migration version: ${version}`);
    versions.add(version);

    const contents = await readFile(path.join(migrationsDir, filename));
    const sql = contents.toString("utf8");
    requireDirective(sql, filename, "up");
    requireDirective(sql, filename, "down");
    migrations.push({ filename, checksum: checksum(contents) });
  }

  return migrations;
}

export async function sealMigrations(migrationsDir = defaultMigrationsDir) {
  const migrations = await inspectMigrations(migrationsDir);
  const manifest = {
    algorithm: "sha256",
    files: Object.fromEntries(migrations.map(({ filename, checksum: value }) => [filename, value]))
  };
  await writeFile(manifestPath(migrationsDir), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export async function verifyMigrations(migrationsDir = defaultMigrationsDir) {
  const migrations = await inspectMigrations(migrationsDir);
  const manifest = JSON.parse(await readFile(manifestPath(migrationsDir), "utf8"));
  if (manifest.algorithm !== "sha256" || typeof manifest.files !== "object" || manifest.files === null) {
    throw new Error("invalid migration checksum manifest");
  }

  const actualNames = migrations.map(({ filename }) => filename);
  const sealedNames = Object.keys(manifest.files).sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(actualNames) !== JSON.stringify(sealedNames)) {
    throw new Error("migration manifest coverage mismatch");
  }

  for (const migration of migrations) {
    if (manifest.files[migration.filename] !== migration.checksum) {
      throw new Error(`migration checksum mismatch: ${migration.filename}`);
    }
  }

  return { count: migrations.length };
}

async function main() {
  const command = process.argv[2] ?? "verify";
  if (command === "seal") {
    const manifest = await sealMigrations();
    console.log(`Sealed ${Object.keys(manifest.files).length} migration(s).`);
    return;
  }
  if (command === "verify") {
    const result = await verifyMigrations();
    console.log(`Verified ${result.count} migration(s).`);
    return;
  }
  throw new Error(`Unknown command: ${command}. Expected "seal" or "verify".`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
