
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  define: {
    'process.env.API_KEY': JSON.stringify(process.env.API_KEY)
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // 告诉 Rollup 不要打包 mqtt，代码中保留 import 'mqtt'
      external: ['mqtt'],
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            return 'vendor';
          }
        },
        // 全局变量映射，确保 UMD/ESM 兼容性
        globals: {
          mqtt: 'mqtt'
        }
      },
    },
  },
  // 必须移除此处的 mqtt，否则 Vite 会尝试在 node_modules 中物理定位它
  optimizeDeps: {
    exclude: ['mqtt']
  }
});
