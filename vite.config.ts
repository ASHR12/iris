import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
  // Relative base so the built index.html resolves assets when Electron loads it
  // from the filesystem (file://) in production / packaged builds.
  base: "./",
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        {
          src: "node_modules/@ricky0123/vad-web/dist/{vad.worklet.bundle.min.js,silero_vad_v5.onnx}",
          dest: "vad-assets",
          rename: { stripBase: 4 },
        },
        {
          src: "node_modules/onnxruntime-web/dist/{ort-wasm-simd-threaded.mjs,ort-wasm-simd-threaded.wasm}",
          dest: "vad-assets",
          rename: { stripBase: 3 },
        },
      ],
    }),
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
