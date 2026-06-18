"use client";

import { useEffect, useState } from "react";
import type { HelpSection } from "./sections";

/**
 * Sticky on-page table of contents for /help.
 *
 * Client island: the page server-renders the sections and their anchor ids;
 * this component owns only the scroll-spy highlight + smooth-scroll-on-click.
 * It receives the already-role-filtered section list from the server so it
 * never has to know about principals or visibility rules.
 */
export default function HelpNav({ sections }: { sections: HelpSection[] }) {
  const [active, setActive] = useState<string>(sections[0]?.id ?? "");

  useEffect(() => {
    if (sections.length === 0) return;

    // Highlight the section whose heading is nearest the top of the viewport.
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      // Bias the active line toward the heading sitting near the top.
      { rootMargin: "-64px 0px -65% 0px", threshold: 0 },
    );

    for (const s of sections) {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [sections]);

  function onClick(e: React.MouseEvent<HTMLAnchorElement>, id: string) {
    const el = document.getElementById(id);
    if (!el) return; // let the default hash jump happen as a fallback
    e.preventDefault();
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    history.replaceState(null, "", `#${id}`);
    setActive(id);
  }

  return (
    <nav
      aria-label="On this page"
      style={{
        position: "sticky",
        top: 74,
        alignSelf: "start",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--faint)",
          margin: "0 0 8px 10px",
        }}
      >
        On this page
      </div>
      {sections.map((s) => {
        const isActive = s.id === active;
        return (
          <a
            key={s.id}
            href={`#${s.id}`}
            onClick={(e) => onClick(e, s.id)}
            style={{
              fontSize: 12.5,
              lineHeight: 1.4,
              padding: "5px 10px",
              borderRadius: 6,
              textDecoration: "none",
              color: isActive ? "var(--ink)" : "var(--muted)",
              background: isActive ? "var(--nav-active)" : "transparent",
              fontWeight: isActive ? 500 : 400,
              borderLeft: isActive
                ? "2px solid var(--accent)"
                : "2px solid transparent",
            }}
          >
            {s.title}
          </a>
        );
      })}
    </nav>
  );
}
