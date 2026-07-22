import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This config runs under Vite via `deno task` (see frontend/deno.json), so the real
// `Deno` global is always present at runtime — but frontend/ is outside the Deno LSP's
// `deno.enablePaths` (.vscode/settings.json), so the editor's plain-TS view of this file
// doesn't know about it without this narrow ambient declaration.
declare const Deno: { build: { os: string } };

export default defineConfig({
  plugins: [
    tanstackRouter({
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
      autoCodeSplitting: true,
      addExtensions: true,
    }),
    react(),
    babel({
      presets: [reactCompilerPreset()],
      // The plugin's default exclude only covers node_modules, but in dev Vite serves
      // pre-bundled dependencies from .vite/deps — the React Compiler must not touch
      // those chunks: the `react/compiler-runtime` imports it injects there bypass
      // Vite's CJS-interop rewriting and break the page ("does not provide an export
      // named 'c'"). First pattern below is the plugin's default, kept verbatim.
      exclude: [/[/\\]node_modules[/\\]|^\0rolldown\/runtime\.js$/, /[/\\]\.vite[/\\]/],
    }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@shared": resolve(fileURLToPath(new URL(".", import.meta.url)), "../shared"),
    },
  },
  optimizeDeps: {
    // The React Compiler injects `import { c } from 'react/compiler-runtime'` into
    // transformed modules, so the dep scanner never sees this import in source. Without
    // pre-bundling it upfront, Vite discovers it mid-session and misses the CJS interop
    // (its dev build assigns `exports.c` inside an IIFE, invisible to static detection),
    // breaking every compiled module. The old plugin-react `babel` option added this
    // automatically; with the compiler in a separate rolldown-plugin-babel pass, it's on us.
    include: ["react/compiler-runtime"],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
    // Deno's Node-compat `fs.watch` shim on Windows can't resolve paths through its
    // symlinked node_modules (from workspace `nodeModulesDir: "auto"`), which crashes
    // Vite's native watcher with "Input watch path is neither a file nor a directory".
    // Polling sidesteps the native watcher entirely at the cost of a bit more CPU — scoped
    // to Windows since native fs events work fine elsewhere and polling isn't free.
    watch: {
      usePolling:
        (globalThis as typeof globalThis & { Deno?: typeof Deno }).Deno?.build.os === "windows",
    },
  },
});
