import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

// onnxruntime-web ships several WASM builds (jsep/WebGPU, asyncify, jspi, plain
// CPU) at 13–26 MB each. Everything under dist/ is embedded into the Go binary
// via //go:embed, so shipping the unused ones cost ~76 MB of dead weight. We run
// inference on the CPU, so force every importer — ours *and* ppu-paddle-ocr,
// which imports "onnxruntime-web" itself — onto the CPU-only build, and copy
// only that variant. The regex is anchored so "onnxruntime-web/wasm" is not
// itself rewritten.
export default defineConfig({
  resolve: {
    alias: [{ find: /^onnxruntime-web$/, replacement: "onnxruntime-web/wasm" }],
  },
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
          // Only the CPU build: its .wasm binary and its .mjs glue loader, both
          // fetched at runtime from ort.env.wasm.wasmPaths (/assets/).
          src: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.{wasm,mjs}",
          dest: "assets",
        },
      ],
    }),
    dropBundledWasm(),
  ],
});

// dropBundledWasm removes any .wasm rollup emits itself. ort's glue references
// the binary with `new URL(...)`, so vite emits a second, hash-named copy of a
// file we already ship via static copy — and since wasmPaths pins the unhashed
// path, that copy is never fetched. Static-copied files are written outside the
// rollup bundle, so they are untouched here.
function dropBundledWasm() {
  return {
    name: "drop-bundled-wasm",
    generateBundle(_options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        if (fileName.endsWith(".wasm")) delete bundle[fileName];
      }
    },
  };
}
