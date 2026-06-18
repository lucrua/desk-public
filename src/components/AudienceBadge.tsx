/**
 * Audience badge — a small mono chip colored by audience.
 *
 * Audiences are admin-configurable data now, so the color map can't be a fixed
 * per-key table. The four legacy mappings are kept verbatim (team/alice/bob/
 * external:*); any other key gets a deterministic color — a stable hash of the
 * key picks one of the four badge token pairs, so a given audience always reads
 * the same color across the app without a config round-trip.
 *
 * `label` is the human-facing text (from the audiences table). When omitted the
 * badge falls back to deriving a label from the key (legacy behavior).
 *
 * Pure presentational; safe in server components.
 */

type TokenPair = { bg: string; ink: string };

const PALETTE: TokenPair[] = [
  { bg: "var(--badge-team-bg)", ink: "var(--badge-team-ink)" },
  { bg: "var(--badge-alice-bg)", ink: "var(--badge-alice-ink)" },
  { bg: "var(--badge-bob-bg)", ink: "var(--badge-bob-ink)" },
  { bg: "var(--badge-external-bg)", ink: "var(--badge-external-ink)" },
];

/** Deterministic FNV-1a-ish hash of a string → a non-negative integer. */
function hashKey(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

type BadgeStyle = { bg: string; ink: string; label: string };

function resolve(audience: string, label?: string): BadgeStyle {
  // Legacy mappings — keep the exact colors for the canonical audiences.
  if (audience === "alice") {
    return { bg: "var(--badge-alice-bg)", ink: "var(--badge-alice-ink)", label: label ?? "alice" };
  }
  if (audience === "bob") {
    return { bg: "var(--badge-bob-bg)", ink: "var(--badge-bob-ink)", label: label ?? "bob" };
  }
  if (audience === "team") {
    return { bg: "var(--badge-team-bg)", ink: "var(--badge-team-ink)", label: label ?? "team" };
  }
  if (audience.startsWith("external:")) {
    const derived = audience.slice("external:".length) || "external";
    return { bg: "var(--badge-external-bg)", ink: "var(--badge-external-ink)", label: label ?? derived };
  }
  if (audience === "external") {
    return { bg: "var(--badge-external-bg)", ink: "var(--badge-external-ink)", label: label ?? "external" };
  }
  // Any other key → deterministic color from the palette, keyed by the string.
  const pair = PALETTE[hashKey(audience) % PALETTE.length];
  return { bg: pair.bg, ink: pair.ink, label: label ?? audience };
}

export default function AudienceBadge({
  audience,
  label,
}: {
  audience: string;
  label?: string;
}) {
  const { bg, ink, label: text } = resolve(audience, label);
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        padding: "3px 8px",
        borderRadius: 99,
        background: bg,
        color: ink,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}
