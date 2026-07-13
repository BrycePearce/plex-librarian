import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// This config runs under `deno run -A npm:vite` (see frontend/deno.json), so the real
// `Deno` global is always present at runtime — but frontend/ is outside the Deno LSP's
// `deno.enablePaths` (.vscode/settings.json), so the editor's plain-TS view of this file
// doesn't know about it without this narrow ambient declaration.
declare const Deno: { build: { os: string } }

export default defineConfig({
  plugins: [
    tanstackRouter({
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
      autoCodeSplitting: true,
    }),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@shared': resolve(fileURLToPath(new URL('.', import.meta.url)), '../shared'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
    // Deno's Node-compat `fs.watch` shim on Windows can't resolve paths through its
    // symlinked node_modules (from workspace `nodeModulesDir: "auto"`), which crashes
    // Vite's native watcher with "Input watch path is neither a file nor a directory".
    // Polling sidesteps the native watcher entirely at the cost of a bit more CPU — scoped
    // to Windows since native fs events work fine elsewhere and polling isn't free.
    watch: {
      usePolling: (globalThis as typeof globalThis & { Deno?: typeof Deno }).Deno?.build.os === 'windows',
    },
  },
})
