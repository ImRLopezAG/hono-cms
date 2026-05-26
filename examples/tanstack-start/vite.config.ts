import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";

export default defineConfig({
  server: {
    port: 8790,
    strictPort: true
  },
  plugins: [
    // tanstackStart MUST come before viteReact
    tanstackStart({
      srcDirectory: "src"
    }),
    viteReact()
  ]
});
