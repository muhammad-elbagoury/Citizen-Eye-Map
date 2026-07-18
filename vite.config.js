import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages serves from https://username.github.io/Citizen-Eye-Map/
  // All built asset URLs must be prefixed with this subpath.
  base: "/Citizen-Eye-Map/",
  server: {
    port: 3000,
    open: true
  },
  build: {
    rollupOptions: {
      // Multi-page app: both index.html and popup.html get bundled and output.
      input: {
        index: "index.html",
        popup: "popup.html"
      }
    }
  }
});
