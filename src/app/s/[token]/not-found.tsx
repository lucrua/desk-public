// Uniform 404 for the share segment. Next maps notFound() within this segment
// here. Copy is deliberately identical across every null cause (unknown /
// revoked / expired / unpublished) — zero signal about why the link is dead
// (DESIGN-NOTES decision 1, spec §15).
import { NOTHING_HERE_HEADING, NOTHING_HERE_SHARE_BODY } from "@/lib/constants";

export default function ShareNotFound() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        color: "var(--ink)",
        fontFamily: "var(--font-serif)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div style={{ maxWidth: 380, textAlign: "center" }}>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            letterSpacing: "0.14em",
            color: "var(--faint)",
            marginBottom: 18,
          }}
        >
          404
        </div>
        <h1
          style={{
            fontSize: 27,
            fontWeight: 500,
            letterSpacing: "-0.01em",
            margin: "0 0 12px",
            lineHeight: 1.25,
          }}
        >
          {NOTHING_HERE_HEADING}
        </h1>
        <p
          style={{
            fontSize: 17,
            lineHeight: 1.6,
            color: "var(--muted)",
            margin: 0,
          }}
        >
          {NOTHING_HERE_SHARE_BODY}
        </p>
      </div>
    </div>
  );
}
