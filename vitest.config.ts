import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));
const wxautoBridgeSuffix = "/scripts/wxauto-rest-bridge.mjs";

export default defineConfig({
  plugins: [
    {
      name: "strip-wxauto-bridge-shebang-for-tests",
      enforce: "pre",
      transform(code, id) {
        const normalizedId = id.replaceAll("\\", "/").split("?")[0];
        if (normalizedId.endsWith(wxautoBridgeSuffix) && code.startsWith("#!/usr/bin/env node")) {
          return {
            code: code.slice("#!/usr/bin/env node".length),
            map: null
          };
        }
      }
    },
    react()
  ],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["tests/setup/canvas.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"]
  },
  resolve: {
    alias: {
      "@": srcPath
    }
  }
});
