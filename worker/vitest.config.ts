import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@feedxml/shared": fileURLToPath(
        new URL("../packages/shared/src/index.ts", import.meta.url),
      ),
      "@feedxml/domain": fileURLToPath(
        new URL("../packages/domain/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
