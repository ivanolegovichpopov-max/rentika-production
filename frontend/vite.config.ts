import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// В разработке (npm run dev) фронтенд и backend работают на разных портах —
// прокси ниже перенаправляет /api на локально запущенный backend (uvicorn на
// 8000), чтобы cookie для refresh-токена работали (см. app/api/routes/auth.py)
// без настройки CORS для каждого дев-порта отдельно.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
});
