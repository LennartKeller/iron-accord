/**
 * Commander Wars sprite ids contain '+' (e.g. "sea+N+E+mask"), which is legal in
 * a URL path but handled inconsistently: some static servers treat it as a
 * space, and percent-encoding it as %2B is not decoded by others (Vite's dev
 * server serves the literal character and 404s the encoded form).
 *
 * Rather than depend on any of that, assets are written to disk under a
 * URL-safe name and both the build tool and the client derive it with this one
 * function.
 */
export function assetFileName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, c => `~${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
