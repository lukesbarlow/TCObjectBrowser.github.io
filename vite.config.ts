import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    port: 5173,
    cors: true,
    headers: {
      "Access-Control-Allow-Origin": "*",
    },
  },
  preview: {
    port: 4173,
    cors: true,
    headers: {
      "Access-Control-Allow-Origin": "*",
    },
  },
});
