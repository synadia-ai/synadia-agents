import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  plugins: [vue()],
  define: {
    // Inlined into the bundle as a string literal — surfaces the
    // dashboard's own package.json version in the UI alongside the
    // wire-protocol version, so operators can tell which build of the
    // dashboard they're looking at.
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/ws": { target: "ws://localhost:3300", ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
});
