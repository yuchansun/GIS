import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// 啟用本機 HTTPS + 對外連線，讓手機也能使用 GPS 定位（定位需安全連線）
export default defineConfig({
  plugins: [basicSsl()],
  server: {
    host: true, // 監聽 0.0.0.0，手機可用區網 IP 連線
    port: 5173,
  },
});
