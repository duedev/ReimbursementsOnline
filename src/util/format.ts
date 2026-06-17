// Date helpers. Receipt dates are stored ISO (yyyy-mm-dd) for sortability and
// unambiguous export; displayed in a friendly local form.

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export function todayIso(): string {
  return toIso(new Date());
}

export function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse an ISO yyyy-mm-dd into a local Date (no timezone surprises). */
export function fromIso(iso: string): Date | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isValidIso(iso: string): boolean {
  return fromIso(iso) !== null;
}

export function formatDate(iso: string): string {
  const d = fromIso(iso);
  if (!d) return iso || "—";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Month index (1-12) from a 3-letter (or longer) month name. */
export function monthFromName(name: string): number | null {
  const key = name.slice(0, 3).toLowerCase();
  return MONTHS[key] ?? null;
}

export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}
