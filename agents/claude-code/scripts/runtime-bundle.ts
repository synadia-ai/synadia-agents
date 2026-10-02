/** Remove generator-only trailing indentation without changing executable code. */
export function normalizeRuntimeBundle(source: string): string {
  return source.replace(/[ \t]+$/gm, '')
}
