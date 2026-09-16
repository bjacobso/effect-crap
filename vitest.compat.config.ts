import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["test/compatibility.test.ts"] } });
