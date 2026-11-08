import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiPort = Number(process.env.SUMDAY_PORT ?? 4321);

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    // In `npm run dev`, Vite serves the UI and forwards /api to the Fastify server.
    proxy: { "/api": `http://127.0.0.1:${apiPort}` },
  },
});
