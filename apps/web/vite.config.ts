
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],

  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:8000",
    },
  },

  test: {
    environment: "jsdom",

    // Tests must not inherit live AWS/Cognito configuration.
    env: {
      VITE_USE_MOCK_API: "true",
      VITE_CLOUD_INGEST_ONLY: "false",
      VITE_CLOUD_PREVIEW: "false",
      VITE_COGNITO_REGION: "",
      VITE_COGNITO_USER_POOL_ID: "",
      VITE_COGNITO_CLIENT_ID: "",
      VITE_COGNITO_DOMAIN: "",
    },

    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/setup.ts"],
    clearMocks: true,
  },
});
