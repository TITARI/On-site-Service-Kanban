import { vi } from "vitest";

// jsdom does not implement HTMLCanvasElement.getContext and logs a noisy
// "Not implemented" warning whenever code probes for canvas support. The app's
// browser image helper treats a null context as "cannot compress" and falls
// back to the pass-through path, so we preserve that behaviour by returning
// null while silencing the console noise.
if (typeof HTMLCanvasElement !== "undefined") {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
}
