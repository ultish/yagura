import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": { target: `http://127.0.0.1:${process.env.YAGURA_PORT ?? 7300}`, changeOrigin: false } } },
  // The repo browser's chunk carries Monaco (about 2.3 MB) and loads only on that page.
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 2500 },
});
