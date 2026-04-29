/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

// Injected at build time by Vite's `define` (see vite.config.ts) — the
// dashboard's own package.json version, surfaced in ConnectionBar.
declare const __APP_VERSION__: string;
