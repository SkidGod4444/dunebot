import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Built pages get a strict CSP: no remote scripts, styles, images or connections, so model output
// can't load a tracking image or send data anywhere from the window.
const csp: Plugin = {
  name: "dunebot-csp",
  apply: "build",
  transformIndexHtml: (html) =>
    html.replace(
      "<head>",
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'" />`,
    ),
};

export default defineConfig({
  root: "ui",
  base: "./",
  plugins: [react(), tailwindcss(), csp],
  build: { outDir: "../dist/ui", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
  server: { port: 5199, strictPort: false },
});
