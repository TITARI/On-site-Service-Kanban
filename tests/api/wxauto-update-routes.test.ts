import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WxautoRelease } from "@/lib/domain/types";
import type { AppRepository } from "@/lib/repositories/app-repository";

const repository = vi.hoisted(() => ({
  listWxautoReleases: vi.fn(),
  getWxautoRelease: vi.fn(),
  saveWxautoRelease: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => ({
    kind: "mariadb",
    listWxautoReleases: repository.listWxautoReleases,
    getWxautoRelease: repository.getWxautoRelease,
    saveWxautoRelease: repository.saveWxautoRelease
  } as unknown as AppRepository)
}));

const publishRoute = await import("@/app/api/admin/wxauto-updates/route");
const latestRoute = await import("@/app/api/updates/wxauto/latest/route");
const downloadRoute = await import("@/app/api/updates/wxauto/[version]/download/route");

const tempRoots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wxauto-route-updates-"));
  tempRoots.push(root);
  return root;
}

function release(overrides: Partial<WxautoRelease> = {}): WxautoRelease {
  return {
    version: "0.2.0",
    channel: "stable",
    fileName: "wxauto-desktop-Setup-0.2.0.exe",
    filePath: path.join("data", "wxauto-updates", "0.2.0", "wxauto-desktop-Setup-0.2.0.exe"),
    fileSize: 123,
    sha256: "a".repeat(64),
    releaseNotes: "Test release",
    manifest: { payload: "{\"version\":\"0.2.0\"}" },
    signature: "base64-signature",
    publishedAt: "2026-06-05T08:00:00.000Z",
    ...overrides
  };
}

afterEach(async () => {
  delete process.env.WXAUTO_UPDATE_PUBLISH_TOKEN;
  delete process.env.WXAUTO_UPDATE_SIGNING_PRIVATE_KEY;
  delete process.env.WXAUTO_UPDATE_ROOT;
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

beforeEach(() => {
  repository.listWxautoReleases.mockReset();
  repository.getWxautoRelease.mockReset();
  repository.saveWxautoRelease.mockReset();
});

describe("wxauto update routes", () => {
  it("rejects publishing without the dedicated token", async () => {
    const response = await publishRoute.POST(new Request("https://board.example/api/admin/wxauto-updates", {
      method: "POST",
      body: new FormData()
    }));

    expect(response.status).toBe(401);
    expect(repository.saveWxautoRelease).not.toHaveBeenCalled();
  });

  it("rejects publishing installers that are not Windows executables", async () => {
    process.env.WXAUTO_UPDATE_PUBLISH_TOKEN = "publish-token";
    const form = new FormData();
    form.set("installer", new File(["zip bytes"], "wxauto-desktop.zip"));

    const response = await publishRoute.POST({
      url: "https://board.example/api/admin/wxauto-updates",
      headers: new Headers({ "x-update-publish-token": "publish-token" }),
      formData: async () => form
    } as unknown as Request);

    expect(response.status).toBe(400);
    expect(repository.saveWxautoRelease).not.toHaveBeenCalled();
  });

  it("rejects publishing installers larger than 250 MiB", async () => {
    process.env.WXAUTO_UPDATE_PUBLISH_TOKEN = "publish-token";
    const form = {
      get: (name: string) => name === "installer" ? {
        name: "wxauto-desktop-Setup-0.2.0.exe",
        size: 250 * 1024 * 1024 + 1,
        arrayBuffer: async () => new ArrayBuffer(0)
      } : ""
    } as unknown as FormData;

    const response = await publishRoute.POST({
      url: "https://board.example/api/admin/wxauto-updates",
      headers: new Headers({ "x-update-publish-token": "publish-token" }),
      formData: async () => form
    } as unknown as Request);

    expect(response.status).toBe(400);
    expect(repository.saveWxautoRelease).not.toHaveBeenCalled();
  });

  it("publishes a signed installer upload with a persisted hash", async () => {
    const root = await tempRoot();
    const { privateKey } = generateKeyPairSync("ed25519");
    process.env.WXAUTO_UPDATE_ROOT = root;
    process.env.WXAUTO_UPDATE_PUBLISH_TOKEN = "publish-token";
    process.env.WXAUTO_UPDATE_SIGNING_PRIVATE_KEY = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    repository.saveWxautoRelease.mockImplementation(async (item) => item);
    const form = new FormData();
    form.set("version", "0.2.0");
    form.set("channel", "stable");
    form.set("releaseNotes", "Test release");
    form.set("installer", new File(["installer bytes"], "wxauto-desktop-Setup-0.2.0.exe", {
      type: "application/octet-stream"
    }));

    const response = await publishRoute.POST({
      url: "https://board.example/api/admin/wxauto-updates",
      headers: new Headers({ "x-update-publish-token": "publish-token" }),
      formData: async () => form
    } as unknown as Request);
    const payload = await response.json();

    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.release).toMatchObject({
      version: "0.2.0",
      channel: "stable",
      fileName: "wxauto-desktop-Setup-0.2.0.exe",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(repository.saveWxautoRelease).toHaveBeenCalledWith(expect.objectContaining({
      filePath: expect.stringContaining("wxauto-desktop-Setup-0.2.0.exe"),
      manifest: expect.objectContaining({ payload: expect.any(String) }),
      signature: expect.any(String)
    }));
  });

  it("returns the newest signed manifest for the requested channel", async () => {
    const older = release({ version: "0.1.0", publishedAt: "2026-06-04T08:00:00.000Z" });
    const newest = release({ version: "0.2.0", publishedAt: "2026-06-05T08:00:00.000Z" });
    repository.listWxautoReleases.mockResolvedValue([
      release({ version: "0.3.0", channel: "beta", publishedAt: "2026-06-06T08:00:00.000Z" }),
      older,
      newest
    ]);

    const response = await latestRoute.GET(new Request(
      "https://board.example/api/updates/wxauto/latest?channel=stable"
    ));

    expect(await response.json()).toEqual({
      payload: newest.manifest.payload,
      signature: newest.signature
    });
  });

  it("rejects a persisted installer path outside the update root", async () => {
    const root = await tempRoot();
    process.env.WXAUTO_UPDATE_ROOT = root;
    repository.getWxautoRelease.mockResolvedValue({
      ...release(),
      filePath: path.resolve(root, "..", "outside.exe")
    });

    const response = await downloadRoute.GET(
      new Request("https://board.example/api/updates/wxauto/0.2.0/download"),
      { params: Promise.resolve({ version: "0.2.0" }) }
    );

    expect(response.status).toBe(404);
  });

  it("downloads a persisted installer from inside the update root", async () => {
    const root = await tempRoot();
    const filePath = path.join(root, "0.2.0", "wxauto-desktop-Setup-0.2.0.exe");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "installer bytes");
    process.env.WXAUTO_UPDATE_ROOT = root;
    repository.getWxautoRelease.mockResolvedValue(release({ filePath }));

    const response = await downloadRoute.GET(
      new Request("https://board.example/api/updates/wxauto/0.2.0/download"),
      { params: Promise.resolve({ version: "0.2.0" }) }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(await response.text()).toBe("installer bytes");
  });
});
