import type { ReactNode } from "react";

/**
 * A quiet informational banner (design decision 2: drift is information, not
 * error — amber, calm, re-publish framing). Generic so it can carry the
 * unpublished notice now and real canon-drift copy when the CLI lands (Task 10).
 *
 * Only `warn` tone is defined today; the prop keeps the door open without
 * implying error styling exists.
 */
export default function DriftBanner({
  tone = "warn",
  label = "drift",
  children,
}: {
  tone?: "warn";
  /** Small uppercase mono tag on the left. */
  label?: string;
  children: ReactNode;
}) {
  // tone is currently warn-only; reference it so the API is honest and lint-clean.
  void tone;
  return (
    <div
      style={{
        border: "1px solid var(--warn-border)",
        background: "var(--warn-bg)",
        borderRadius: 8,
        padding: "10px 14px",
        marginBottom: 20,
        display: "flex",
        alignItems: "baseline",
        gap: 10,
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--warn-ink)",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 12.5, color: "var(--warn-ink)" }}>{children}</span>
    </div>
  );
}
