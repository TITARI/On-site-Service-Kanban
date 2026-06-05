import { afterEach, describe, expect, it, vi } from "vitest";
import { readImagesAsDataUrls } from "@/lib/client/images";

describe("client image handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("downscales large photos before returning data URLs", async () => {
    const imageBitmap = { width: 4000, height: 3000, close: vi.fn() };
    const context = { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
      toDataURL: vi.fn((type: string, quality?: number) => `data:${type};quality=${quality};base64,compressed`)
    };
    const createElement = document.createElement.bind(document);

    vi.stubGlobal("createImageBitmap", vi.fn(async () => imageBitmap));
    vi.spyOn(document, "createElement").mockImplementation((tagName, options) => {
      if (tagName === "canvas") return canvas as unknown as HTMLCanvasElement;
      return createElement(tagName, options);
    });

    const result = await readImagesAsDataUrls([new File(["large-photo"], "现场.jpg", { type: "image/jpeg" })]);

    expect(result).toEqual(["data:image/jpeg;quality=0.72;base64,compressed"]);
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(1200);
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 1600, 1200);
    expect(context.drawImage).toHaveBeenCalledWith(imageBitmap, 0, 0, 1600, 1200);
    expect(imageBitmap.close).toHaveBeenCalled();
  });
});
