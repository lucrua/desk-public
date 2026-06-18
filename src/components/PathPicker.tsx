"use client";

import { pathSuggestions } from "@/app/(hub)/docs/tree-model";

/**
 * Shared folder path-picker — the autocomplete field used by both the Move…
 * dialog (DocActions + the docs-tree hover affordance) and the Upload panel's
 * "folder" field. Round-2 design: a free-text mono input plus a suggestion list
 * built from `existingFolders` (root + matching folders + a synthetic "new
 * folder — created on move" row when the typed path is new & valid).
 *
 * Controlled: the parent owns `value`. The picker calls `onChange` on every
 * keystroke and on a suggestion click, and `onEnter` when the user presses
 * Enter (the Move dialog confirms on Enter). Pure suggestion logic lives in the
 * docs view-model (`pathSuggestions`), so this component stays presentational
 * and the list is unit-tested without a renderer.
 */
export default function PathPicker({
  value,
  onChange,
  existingFolders,
  onEnter,
  onEscape,
  autoFocus,
  placeholder = "type a path, e.g. finance/archive",
  invalid = false,
}: {
  value: string;
  onChange: (next: string) => void;
  existingFolders: string[];
  onEnter?: () => void;
  onEscape?: () => void;
  autoFocus?: boolean;
  placeholder?: string;
  invalid?: boolean;
}) {
  const suggestions = pathSuggestions(value, existingFolders);

  return (
    <div style={{ position: "relative" }}>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onEnter?.();
          } else if (e.key === "Escape") {
            onEscape?.();
          }
        }}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label="Destination folder"
        style={{
          width: "100%",
          padding: "8px 11px",
          fontSize: 13,
          fontFamily: "var(--font-mono)",
          border: `1px solid ${invalid ? "var(--danger-border)" : "var(--accent)"}`,
          borderRadius: 8,
          background: "var(--surface-alt)",
          color: "var(--ink)",
          outline: "none",
        }}
      />
      <div
        style={{
          marginTop: 6,
          border: "1px solid var(--hairline)",
          borderRadius: 9,
          background: "var(--surface)",
          overflow: "hidden",
        }}
      >
        {suggestions.map((s) => (
          <button
            key={`${s.value}|${s.isNew ? "new" : "exist"}`}
            type="button"
            onClick={() => onChange(s.value)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              textAlign: "left",
              padding: "8px 12px",
              border: "none",
              borderBottom: "1px solid var(--hairline)",
              background:
                s.selected || s.isNew ? "var(--ref-bg, var(--surface-alt))" : "transparent",
              cursor: "pointer",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: s.selected || s.isNew ? "var(--ref-ink, var(--accent))" : "var(--ink)",
            }}
          >
            <span style={{ flex: 1 }}>{s.label}</span>
            <span style={{ fontSize: 10, color: "var(--faint)" }}>{s.note}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
