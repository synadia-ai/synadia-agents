// Re-export the server's wire types for the browser bundle. The server file
// is type-only; Vite elides the import at runtime.
export type * from "../server/wire.ts";
