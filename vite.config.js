import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// "base" doit correspondre au nom du dépôt GitHub (freud-el/finance -> "/finance/")
// pour que GitHub Pages retrouve bien les fichiers CSS/JS une fois en ligne.
export default defineConfig({
  plugins: [react()],
  base: "/finance/",
});
