import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // Optional frontend-only workaround until Developer 2 supplies CORS.
    // Use VITE_API_BASE_URL=/ with VITE_USE_MOCK_API=false to opt in.
    proxy: { "/api": "http://127.0.0.1:8000" },
  },
  test: {
    env: { VITE_USE_MOCK_API: "true" },
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/setup.ts"],
    clearMocks: true,
  },
});
