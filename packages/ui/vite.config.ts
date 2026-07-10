import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@ratel-ai/ratel-local-core/agent-import-workflow": fileURLToPath(
        new URL("../core/src/agent-import-workflow.ts", import.meta.url),
      ),
    },
  },
  server: {
    host: "127.0.0.1",
    proxy: process.env.RATEL_LOCAL_API_TARGET
      ? {
          "/api": {
            target: process.env.RATEL_LOCAL_API_TARGET,
            changeOrigin: true,
          },
        }
      : undefined,
  },
  plugins: [react(), tailwindcss()],
});
