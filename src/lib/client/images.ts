const COMPRESSED_IMAGE_TYPE = "image/jpeg";
const COMPRESSED_IMAGE_QUALITY = 0.72;
const MAX_IMAGE_EDGE_PX = 1600;
const PASSTHROUGH_IMAGE_TYPES = new Set(["image/gif", "image/svg+xml"]);

type DecodedImage = CanvasImageSource & {
  width: number;
  height: number;
  close?: () => void;
};

export function readFileAsDataUrl(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("图片读取失败")));
    reader.readAsDataURL(file);
  });
}

function canCompressInBrowser() {
  if (typeof document === "undefined") return false;

  try {
    const canvas = document.createElement("canvas");
    return typeof canvas.getContext === "function" && Boolean(canvas.getContext("2d")) && typeof canvas.toDataURL === "function";
  } catch {
    return false;
  }
}

function shouldCompress(file: File) {
  return file.type.startsWith("image/") && !PASSTHROUGH_IMAGE_TYPES.has(file.type);
}

function outputSize(width: number, height: number) {
  const longestEdge = Math.max(width, height);
  const scale = longestEdge > MAX_IMAGE_EDGE_PX ? MAX_IMAGE_EDGE_PX / longestEdge : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    return await createImageBitmap(file);
  }

  const dataUrl = await readFileAsDataUrl(file);
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", () => reject(new Error("图片读取失败")));
    image.src = dataUrl;
  });
}

async function compressImageAsDataUrl(file: File) {
  const image = await decodeImage(file);
  try {
    const size = outputSize(image.width, image.height);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;

    const context = canvas.getContext("2d");
    if (!context) return await readFileAsDataUrl(file);

    context.fillStyle = "#fff";
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(image, 0, 0, size.width, size.height);
    return canvas.toDataURL(COMPRESSED_IMAGE_TYPE, COMPRESSED_IMAGE_QUALITY);
  } finally {
    image.close?.();
  }
}

async function readImageAsDataUrl(file: File) {
  if (!shouldCompress(file) || !canCompressInBrowser()) return await readFileAsDataUrl(file);

  try {
    return await compressImageAsDataUrl(file);
  } catch {
    return await readFileAsDataUrl(file);
  }
}

export async function readImagesAsDataUrls(files: FileList | File[]) {
  const imageFiles = Array.from(files).filter((file) => file.type.startsWith("image/"));
  const dataUrls: string[] = [];
  for (const file of imageFiles) {
    dataUrls.push(await readImageAsDataUrl(file));
  }

  return dataUrls;
}
