import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles/globals.css"), "utf8");

function ruleFor(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, "m").exec(css);
  return match?.groups?.body ?? "";
}

describe("image viewer layout css", () => {
  it("keeps the title and controls fixed while only the image stage scrolls", () => {
    expect(ruleFor(".image-viewer-head")).toContain("position: fixed");
    expect(ruleFor(".image-viewer-tools")).toContain("position: fixed");
    expect(ruleFor(".image-viewer-tools")).toContain("bottom: var(--viewer-edge-bottom)");
    expect(ruleFor(".image-viewer-tools")).toContain("z-index: 3");
    expect(ruleFor(".image-viewer-body")).toContain("position: fixed");
    expect(ruleFor(".image-viewer-body")).toContain("z-index: 1");
    expect(ruleFor(".image-viewer-body")).toContain("top: calc(var(--viewer-edge-top) + var(--viewer-head-space))");
    expect(ruleFor(".image-viewer-body")).toContain("bottom: calc(var(--viewer-edge-bottom) + var(--viewer-tools-space))");
    expect(ruleFor(".image-viewer-stage")).toContain("overflow: auto");
  });
});
