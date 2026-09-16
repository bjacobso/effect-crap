import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["operations.test.ts"],
    coverage: { include: ["src/**/*.ts"], reporter: ["json"] },
  },
});
