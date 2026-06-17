/** Collision-resistant id. Uses crypto.randomUUID where available. */
export function uid(prefix = ""): string {
  const g = globalThis as { crypto?: Crypto };
  const base =
    g.crypto && "randomUUID" in g.crypto
      ? g.crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return prefix ? `${prefix}_${base}` : base;
}
