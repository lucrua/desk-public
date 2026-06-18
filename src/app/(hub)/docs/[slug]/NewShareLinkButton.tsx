"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import ShareModal, { type ShareVersionOption } from "@/components/ShareModal";

/**
 * "New link" button for the per-doc Share links panel. Opens the existing
 * ShareModal; on close, refreshes the route so a freshly-created link shows up
 * in the table without a manual reload.
 */
export default function NewShareLinkButton({
  slug,
  versions,
}: {
  slug: string;
  versions?: ShareVersionOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          fontSize: 12,
          fontWeight: 500,
          padding: "5px 11px",
          borderRadius: 7,
          border: "1px solid var(--hairline)",
          background: "var(--surface)",
          color: "var(--ink)",
          cursor: "pointer",
          fontFamily: "var(--font-sans)",
        }}
      >
        New link
      </button>
      {open && (
        <ShareModal
          docSlug={slug}
          versions={versions}
          onClose={() => {
            setOpen(false);
            router.refresh();
          }}
        />
      )}
    </>
  );
}
