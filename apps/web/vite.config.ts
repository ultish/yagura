import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": { target: `http://127.0.0.1:${process.env.YAGURA_PORT ?? 7300}`, changeOrigin: false } } },
  build: { outDir: "dist", emptyOutDir: true },
});
