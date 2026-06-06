import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSignedManifest,
  createWxautoUpdateService,
  storeInstaller
} from "@/lib/integrations/wxauto/update-service";
import type { AppRepository } from "@/lib/repositories/app-repository";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wxauto-updates-"));
  tempRoots.push(root);
  return root;
}

describe("wxauto update service", () => {
  it("signs a canonical update manifest with Ed25519", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signed = createSignedManifest({
      version: "0.2.0",
      channel: "stable",
      fileName: "wxauto-desktop-Setup-0.2.0.exe",
      fileSize: 123,
      sha256: "a".repeat(64),
      releaseNotes: "Test release",
      downloadUrl: "https://board.example/api/updates/wxauto/0.2.0/download",
      publishedAt: "2026-06-05T08:00:00.000Z"
    }, privateKey.export({ format: "pem", type: "pkcs8" }).toString());

    expect(verify(null, Buffer.from(signed.payload), publicKey, Buffer.from(signed.signature, "base64"))).toBe(true);
    expect(signed.payload).toBe(JSON.stringify({
      channel: "stable",
      downloadUrl: "https://board.example/api/updates/wxauto/0.2.0/download",
      fileName: "wxauto-desktop-Setup-0.2.0.exe",
      fileSize: 123,
      publishedAt: "2026-06-05T08:00:00.000Z",
      releaseNotes: "Test release",
      sha256: "a".repeat(64),
      version: "0.2.0"
    }));
  });

  it("stores installers under a version directory and hashes the bytes", async () => {
    const root = await tempRoot();
    const bytes = new TextEncoder().encode("installer bytes");

    const stored = await storeInstaller(root, "0.2.0", "..\\wxauto-desktop-Setup-0.2.0.exe", bytes);

    expect(stored.fileName).toBe("wxauto-desktop-Setup-0.2.0.exe");
    expect(stored.fileSize).toBe(bytes.byteLength);
    expect(stored.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(readFile(stored.filePath, "utf8")).resolves.toBe("installer bytes");
    expect(path.relative(root, stored.filePath).startsWith("..")).toBe(false);
  });

  it("publishes a signed release without storing installer bytes in the repository", async () => {
    const root = await tempRoot();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const saved = vi.fn(async (release) => release);
    const repository = {
      saveWxautoRelease: saved
    } as unknown as AppRepository;

    const release = await createWxautoUpdateService(repository, {
      updateRoot: root,
      baseUrl: "https://board.example",
      privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      now: () => new Date("2026-06-05T08:00:00.000Z")
    }).publish({
      version: "0.2.0",
      channel: "stable",
      fileName: "wxauto-desktop-Setup-0.2.0.exe",
      releaseNotes: "Test release",
      bytes: new TextEncoder().encode("installer bytes")
    });

    expect(saved).toHaveBeenCalledWith(expect.objectContaining({
      version: "0.2.0",
      fileName: "wxauto-desktop-Setup-0.2.0.exe",
      fileSize: 15,
      filePath: expect.stringContaining("wxauto-desktop-Setup-0.2.0.exe")
    }));
    expect(release.manifest.payload).toContain("\"downloadUrl\":\"https://board.example/api/updates/wxauto/0.2.0/download\"");
    expect(verify(null, Buffer.from(String(release.manifest.payload)), publicKey, Buffer.from(release.signature, "base64"))).toBe(true);
  });
});
