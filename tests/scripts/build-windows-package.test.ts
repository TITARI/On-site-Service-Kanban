import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const sourceScript = path.join(process.cwd(), "scripts", "build-windows-package.ps1");
const tempRoots: string[] = [];
const windowsIt = process.platform === "win32" ? it : it.skip;

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wxauto-board-package-"));
  tempRoots.push(root);

  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, ".next", "standalone"), { recursive: true });
  await mkdir(path.join(root, ".next", "static"), { recursive: true });
  await mkdir(path.join(root, "data", "wxauto-updates"), { recursive: true });
  await mkdir(path.join(root, "db", "migrations"), { recursive: true });

  await copyFile(sourceScript, path.join(root, "scripts", "build-windows-package.ps1"));
  await writeFile(path.join(root, ".next", "standalone", "server.js"), "console.log('server');\n");
  await writeFile(path.join(root, ".next", "static", "BUILD_ID"), "test-build\n");
  await writeFile(path.join(root, "data", "app-state.json"), "{}\n");
  await writeFile(path.join(root, "data", "wxauto-updates", "old-installer.exe"), "stale bytes\n");
  await writeFile(path.join(root, "db", "migrations", "003_wxauto_mcp.sql"), "CREATE TABLE wxauto_agents (id TEXT);\n");

  return root;
}

async function exists(filePath: string) {
  await access(filePath);
}

describe("Windows board package script", () => {
  windowsIt("packages migrations and excludes wxauto update artifacts when optional deploy files are absent", async () => {
    const root = await tempProject();
    const script = path.join(root, "scripts", "build-windows-package.ps1");

    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-SkipBuild",
      "-PackageName",
      "verify"
    ], {
      cwd: root,
      timeout: 30_000,
      windowsHide: true
    });

    const packageDir = path.join(root, "release", "verify");
    await expect(readFile(path.join(packageDir, "db", "migrations", "003_wxauto_mcp.sql"), "utf8"))
      .resolves.toContain("wxauto_agents");
    await expect(readFile(path.join(packageDir, "data", "app-state.json"), "utf8")).resolves.toBe("{}\n");
    await expect(exists(path.join(packageDir, "data", "wxauto-updates"))).rejects.toThrow();
    await expect(exists(path.join(root, "release", "verify.zip"))).resolves.toBeUndefined();
  }, 45_000);
});
