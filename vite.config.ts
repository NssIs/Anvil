import { defineConfig, type Plugin } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// WebKitGTK hard-rejects module scripts served with a non-JS MIME type, and it
// caches responses by URL — one bad header and the webview keeps replaying
// "'application/octet-stream' is not a valid JavaScript MIME type" from its
// disk cache on every launch, which kills the whole app bundle. The shader
// template files (.fsh/.vsh/.glsl/...) are imported as ?raw modules and their
// extensions have no registered MIME type, so they are the ones at risk.
// This middleware runs ahead of Vite's own and guarantees those module
// responses always go out as JavaScript and are never cached.
const shaderPackRawMime = (): Plugin => ({
  name: "anvil:shaderpack-raw-mime",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = req.url ?? "";
      if (url.startsWith("/src-tauri/shaderpack/") && /[?&]raw\b/.test(url)) {
        const setHeader = res.setHeader.bind(res);
        res.setHeader = (name: string, value: number | string | readonly string[]) => {
          const lower = name.toLowerCase();
          if (lower === "content-type" && (!value || String(value).includes("octet-stream"))) {
            return setHeader("Content-Type", "text/javascript");
          }
          if (lower === "cache-control") {
            return setHeader("Cache-Control", "no-store");
          }
          return setHeader(name, value);
        };
        res.setHeader("Content-Type", "text/javascript");
        res.setHeader("Cache-Control", "no-store");
      }
      next();
    });
  },
});

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [shaderPackRawMime()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
