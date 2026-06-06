import { createHash, sign } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WxautoRelease } from "@/lib/domain/types";
import { getAppRepository, type AppRepository } from "@/lib/repositories/app-repository";

export const MAX_INSTALLER_BYTES = 250 * 1024 * 1024;

export type UpdateManifestPayload = {
  version: string;
  channel: string;
  fileName: string;
  fileSize: number;
  sha256: string;
  releaseNotes: string;
  downloadUrl: string;
  publishedAt: string;
};

export type PublishWxautoUpdateInput = {
  version: string;
  channel: string;
  fileName: string;
  releaseNotes: string;
  bytes: Uint8Array;
};

export type WxautoUpdateServiceOptions = {
  updateRoot?: string;
  baseUrl?: string;
  privateKeyPem?: string;
  now?: () => Date;
};

const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function defaultWxautoUpdateRoot() {
  return process.env.WXAUTO_UPDATE_ROOT?.trim() || path.join(process.cwd(), "data", "wxauto-updates");
}

export function canonicalManifest(payload: UpdateManifestPayload) {
  return JSON.stringify(payload, Object.keys(payload).sort());
}

export function createSignedManifest(payload: UpdateManifestPayload, privateKeyPem: string) {
  const canonical = canonicalManifest(payload);
  return {
    payload: canonical,
    signature: sign(null, Buffer.from(canonical), privateKeyPem).toString("base64")
  };
}

function safeInstallerFileName(fileName: string) {
  return path.basename(fileName.replaceAll("\\", "/"));
}

export async function storeInstaller(root: string, version: string, fileName: string, bytes: Uint8Array) {
  if (!versionPattern.test(version)) throw new Error("Invalid version");
  const safeName = safeInstallerFileName(fileName);
  if (!safeName) throw new Error("Invalid file name");
  const directory = path.join(root, version);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, safeName);
  await writeFile(filePath, bytes);
  return {
    filePath,
    fileName: safeName,
    fileSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

export function resolveSafeInstallerPath(updateRoot: string, filePath: string) {
  const root = path.resolve(updateRoot);
  const resolvedPath = path.resolve(filePath);
  const relative = path.relative(root, resolvedPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolvedPath;
}

export function createWxautoUpdateService(
  repository: AppRepository = getAppRepository(),
  options: WxautoUpdateServiceOptions = {}
) {
  return {
    publish: async (input: PublishWxautoUpdateInput): Promise<WxautoRelease> => {
      if (!input.fileName.toLowerCase().endsWith(".exe")) throw new Error("Installer must be an .exe file");
      if (input.bytes.byteLength > MAX_INSTALLER_BYTES) throw new Error("Installer exceeds 250 MiB");
      const privateKeyPem = options.privateKeyPem ?? process.env.WXAUTO_UPDATE_SIGNING_PRIVATE_KEY;
      if (!privateKeyPem) throw new Error("WXAUTO_UPDATE_SIGNING_PRIVATE_KEY is not configured");

      const publishedAt = (options.now?.() ?? new Date()).toISOString();
      const stored = await storeInstaller(
        options.updateRoot ?? defaultWxautoUpdateRoot(),
        input.version,
        input.fileName,
        input.bytes
      );
      const baseUrl = options.baseUrl?.replace(/\/+$/, "") ?? "";
      const manifestPayload: UpdateManifestPayload = {
        version: input.version,
        channel: input.channel,
        fileName: stored.fileName,
        fileSize: stored.fileSize,
        sha256: stored.sha256,
        releaseNotes: input.releaseNotes,
        downloadUrl: `${baseUrl}/api/updates/wxauto/${encodeURIComponent(input.version)}/download`,
        publishedAt
      };
      const signed = createSignedManifest(manifestPayload, privateKeyPem);
      return await repository.saveWxautoRelease({
        version: input.version,
        channel: input.channel,
        fileName: stored.fileName,
        filePath: stored.filePath,
        fileSize: stored.fileSize,
        sha256: stored.sha256,
        releaseNotes: input.releaseNotes,
        manifest: { payload: signed.payload },
        signature: signed.signature,
        publishedAt
      });
    }
  };
}
