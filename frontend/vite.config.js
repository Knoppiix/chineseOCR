import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
  build: {
    target: "esnext",
  },
  optimizeDeps: {
    exclude: ["onnxruntime-web"],
  },
  plugins: [
    viteStaticCopy({
      targets: [
        {
          // .wasm binaries AND their .mjs glue loaders — ort fetches both from
          // ort.env.wasm.wasmPaths (/assets/) at runtime.
          src: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded*.{wasm,mjs}",
          dest: "assets",
        },
      ],
    }),
  ],
});
