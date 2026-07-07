"use client";

import { useState } from "react";

/**
 * Content / Settings tab shell for the space page (UI polish S2, decision D3).
 *
 * A thin client island that ONLY toggles which of two server-rendered groups is
 * visible. Both groups are rendered on the server — the page (an RSC) builds
 * them and passes them here as props (the sanctioned "slot" pattern: Server
 * Components rendered ahead of time, handed to a Client Component as rendered
 * output). Both stay mounted in the DOM; switching flips the `hidden` attribute,
 * so nothing re-fetches and server rendering is fully preserved. Default =
 * Content.
 *
 * `hasSettings` gates the Settings tab: a viewer with no settings sections to
 * see gets neither the tab nor its (empty) panel — the tab never NEWLY exposes
 * anything. WHO sees each panel is decided in `page.tsx`; this shell only
 * decides WHERE (which tab) and whether an empty Settings tab is shown at all.
 */
export default function SpaceTabs({
  content,
  settings,
  hasSettings,
}: {
  content: React.ReactNode;
  settings: React.ReactNode;
  hasSettings: boolean;
}) {
  const [tab, setTab] = useState<"content" | "settings">("content");

  return (
    <div>
      <div
        role="tablist"
        aria-label="Space sections"
        style={{
          display: "flex",
          gap: 4,
          borderBottom: "1px solid var(--hairline)",
          marginBottom: 24,
        }}
      >
        <TabButton
          label="Content"
          active={tab === "content"}
          onClick={() => setTab("content")}
        />
        {hasSettings && (
          <TabButton
            label="Settings"
            active={tab === "settings"}
            onClick={() => setTab("settings")}
          />
        )}
      </div>

      <div role="tabpanel" aria-label="Content" hidden={tab !== "content"}>
        {content}
      </div>
      {hasSettings && (
        <div role="tabpanel" aria-label="Settings" hidden={tab !== "settings"}>
          {settings}
        </div>
      )}
    </div>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        border: "none",
        background: "none",
        font: "inherit",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        padding: "8px 14px",
        cursor: "pointer",
        color: active ? "var(--ink)" : "var(--muted)",
        borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
        marginBottom: -1,
      }}
    >
      {label}
    </button>
  );
}
