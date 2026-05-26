import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      routesDirectory: "src/app",
      generatedRouteTree: "src/routeTree.gen.ts"
    }),
    react(),
    tailwindcss()
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      components: resolve(__dirname, "src/components"),
      ui: resolve(__dirname, "src/components/ui"),
      lib: resolve(__dirname, "src/lib"),
      hooks: resolve(__dirname, "src/hooks"),
      utils: resolve(__dirname, "src/lib/utils")
    }
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "vendor-react";
          if (/[\\/]node_modules[\\/](@tiptap|@prosemirror|prosemirror-)[\\/]/.test(id)) return "vendor-editor";
          if (id.includes("/node_modules/@tanstack/")) return "vendor-misc";
          if (/[\\/]node_modules[\\/](@base-ui|cmdk|lucide-react|recharts|react-day-picker|embla-carousel-react|input-otp|vaul|sonner)[\\/]/.test(id)) return "vendor-ui";
          return "vendor-misc";
        }
      }
    }
  }
});
