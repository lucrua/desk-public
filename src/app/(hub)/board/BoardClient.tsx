"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Markdown from "@/components/Markdown";
import {
  type BoardBucket,
  type BoardCard,
  checklistProgress,
  ownerInitial,
  groupCardsByBucket,
  filterByOwner,
  resolveVisibleDropToFullIndex,
  uiCanEdit,
  activityLine,
} from "./view-model";

type Person = { id: number; name: string };
type ActivityEvent = { id: number; kind: string; payload: Record<string, unknown>; actorName: string; createdAt: string };

type Props = {
  isAdmin: boolean;
  myUserId: number | null;
  initialBuckets: BoardBucket[];
  initialCards: BoardCard[];
  people: Person[];
};

type DropTarget = { bucketId: number; index: number } | null;

/**
 * The board island. Owns drag-and-drop (HTML5, no deps), the right-panel drawer
 * (not a modal — keeps board context), the admin bucket ⋯ menu, the keyboard
 * move-to menu on every card (also `M`), the per-column composer, the archived
 * strip, and the owner/bucket filters. Every mutation calls the REST API then
 * refetches the board; the drawer pulls the activity trail from
 * /api/cards/[id]/events.
 *
 * Locked-card affordance for members: cards they don't own get a default cursor,
 * a quiet `view` tag, disabled menu items + one-line explanation, and a
 * read-only drawer banner — mirroring the server authz exactly (uiCanEdit ===
 * canEditCard).
 */
export default function BoardClient({ isAdmin, myUserId, initialBuckets, initialCards, people }: Props) {
  const [buckets, setBuckets] = useState<BoardBucket[]>(initialBuckets);
  const [cards, setCards] = useState<BoardCard[]>(initialCards);

  const [ownerFilter, setOwnerFilter] = useState<number | null>(null); // null = all
  const [bucketFilter, setBucketFilter] = useState<number | null>(null); // null = all
  const [archivedOpen, setArchivedOpen] = useState(false);

  const [dragId, setDragId] = useState<number | null>(null);
  const [drop, setDrop] = useState<DropTarget>(null);

  const [cardMenuId, setCardMenuId] = useState<number | null>(null);
  const [bucketMenuId, setBucketMenuId] = useState<number | null>(null);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameText, setRenameText] = useState("");
  const [composerBucketId, setComposerBucketId] = useState<number | null>(null);
  const [composerText, setComposerText] = useState("");
  const [addingBucket, setAddingBucket] = useState(false);
  const [newBucketText, setNewBucketText] = useState("");

  const [drawerId, setDrawerId] = useState<number | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const peopleById = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of people) m.set(p.id, p.name);
    return m;
  }, [people]);
  const bucketLabelByKey = useCallback(
    (key: string) => buckets.find((b) => b.key === key)?.label ?? key,
    [buckets],
  );

  // ── data refresh ──────────────────────────────────────────────────────────
  const refetch = useCallback(async () => {
    try {
      const [bRes, cRes] = await Promise.all([
        fetch("/api/buckets"),
        fetch("/api/cards?includeArchived=1"),
      ]);
      if (bRes.ok) setBuckets((await bRes.json()).buckets);
      if (cRes.ok) setCards((await cRes.json()).cards);
    } catch {
      /* keep last-known state */
    }
  }, []);

  const api = useCallback(
    async (url: string, init: RequestInit): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(url, { headers: { "content-type": "application/json" }, ...init });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          setError(j.error ?? `Request failed (${res.status})`);
          return false;
        }
        await refetch();
        return true;
      } catch {
        setError("Network error");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refetch],
  );

  // ── derived board ───────────────────────────────────────────────────────────
  const liveCards = useMemo(() => cards.filter((c) => c.archivedAt == null), [cards]);
  const archivedCards = useMemo(() => cards.filter((c) => c.archivedAt != null), [cards]);
  const grouped = useMemo(() => groupCardsByBucket(liveCards, buckets), [liveCards, buckets]);

  // ── close menus on Escape / outside click ─────────────────────────────────
  const closeMenus = useCallback(() => {
    setCardMenuId(null);
    setBucketMenuId(null);
  }, []);
  const anyMenuOpen = cardMenuId != null || bucketMenuId != null;

  // ── drawer load ───────────────────────────────────────────────────────────
  // Fetch the activity trail whenever the drawer opens (or its card mutates).
  // We don't clear on close synchronously — the drawer is unmounted when
  // drawerId is null, so stale activity is never visible; it's overwritten on
  // the next open.
  useEffect(() => {
    if (drawerId == null) return;
    let cancelled = false;
    fetch(`/api/cards/${drawerId}/events`)
      .then((r) => (r.ok ? r.json() : { events: [] }))
      .then((j) => {
        if (!cancelled) setActivity(j.events ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [drawerId, cards]);

  // ── mutations ───────────────────────────────────────────────────────────────
  const moveCard = useCallback(
    async (cardId: number, bucketId: number, visibleIndex: number | null) => {
      // Resolve the visible (owner-filtered) drop slot to a full insert index so
      // the move lands where the user sees it even with a filter active.
      let index = visibleIndex;
      if (visibleIndex != null) {
        const full = (grouped.get(bucketId) ?? []).filter((c) => c.id !== cardId);
        const visible = filterByOwner(full, ownerFilter);
        index = resolveVisibleDropToFullIndex(
          visible.map((c) => c.id),
          full.map((c) => c.id),
          visibleIndex,
        );
      }
      await api(`/api/cards/${cardId}/move`, {
        method: "POST",
        body: JSON.stringify({ bucketId, index }),
      });
      setDragId(null);
      setDrop(null);
      setCardMenuId(null);
    },
    [api, grouped, ownerFilter],
  );

  const createCard = useCallback(
    async (bucketId: number, title: string) => {
      const t = title.trim();
      if (!t) return;
      await api("/api/cards", { method: "POST", body: JSON.stringify({ title: t, bucketId }) });
    },
    [api],
  );

  const archiveCard = useCallback(
    async (cardId: number, archived: boolean) => {
      await api(`/api/cards/${cardId}`, { method: "PATCH", body: JSON.stringify({ archived }) });
    },
    [api],
  );

  const toggleChecklistItem = useCallback(
    async (card: BoardCard, idx: number) => {
      const next = card.checklist.map((it, i) => (i === idx ? { ...it, done: !it.done } : it));
      await api(`/api/cards/${card.id}`, { method: "PATCH", body: JSON.stringify({ checklist: next }) });
    },
    [api],
  );

  const assignOwner = useCallback(
    async (cardId: number, ownerUserId: number | null) => {
      await api(`/api/cards/${cardId}`, { method: "PATCH", body: JSON.stringify({ ownerUserId }) });
    },
    [api],
  );

  const setDocSlug = useCallback(
    async (cardId: number, docSlug: string | null) => {
      await api(`/api/cards/${cardId}`, { method: "PATCH", body: JSON.stringify({ docSlug }) });
    },
    [api],
  );

  const createBucket = useCallback(
    async (label: string) => {
      const t = label.trim();
      if (!t) return;
      await api("/api/buckets", { method: "POST", body: JSON.stringify({ label: t }) });
    },
    [api],
  );

  const renameBucket = useCallback(
    async (id: number, label: string) => {
      const t = label.trim();
      if (!t) return;
      await api(`/api/buckets/${id}`, { method: "PATCH", body: JSON.stringify({ label: t }) });
    },
    [api],
  );

  const reorderBucket = useCallback(
    async (id: number, dir: -1 | 1) => {
      const ordered = [...buckets].sort((a, b) => a.position - b.position).map((b) => b.id);
      const i = ordered.indexOf(id);
      const j = i + dir;
      if (j < 0 || j >= ordered.length) return;
      [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
      await api("/api/buckets", { method: "PATCH", body: JSON.stringify({ orderedIds: ordered }) });
      setBucketMenuId(null);
    },
    [api, buckets],
  );

  const deleteBucket = useCallback(
    async (id: number) => {
      await api(`/api/buckets/${id}`, { method: "DELETE" });
      setBucketMenuId(null);
    },
    [api],
  );

  // ── render helpers ───────────────────────────────────────────────────────────
  const orderedBuckets = useMemo(
    () => [...buckets].sort((a, b) => a.position - b.position),
    [buckets],
  );
  const drawerCard = drawerId != null ? cards.find((c) => c.id === drawerId) ?? null : null;
  const drawerEditable = drawerCard ? uiCanEdit(isAdmin, drawerCard, myUserId) : false;

  const mono = "var(--font-mono)";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 50px)", overflow: "hidden" }}>
      {/* filter row */}
      <div style={{ flex: "none", padding: "12px 20px 10px", display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
        <FilterGroup
          label="owner"
          chips={[{ id: null, label: "all" }, ...people.map((p) => ({ id: p.id, label: p.name.toLowerCase() }))]}
          active={ownerFilter}
          onPick={setOwnerFilter}
        />
        <FilterGroup
          label="bucket"
          chips={[{ id: null, label: "all" }, ...orderedBuckets.map((b) => ({ id: b.id, label: b.label.toLowerCase() }))]}
          active={bucketFilter}
          onPick={setBucketFilter}
        />
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>
          {error && <span style={{ fontSize: 12, color: "var(--danger-ink, #9C4A3C)" }}>{error}</span>}
          {busy && <span style={{ fontSize: 12, color: "var(--faint)" }}>saving…</span>}
          <button
            onClick={() => setArchivedOpen((v) => !v)}
            style={{
              fontFamily: mono,
              fontSize: 10.5,
              padding: "4px 10px",
              borderRadius: 99,
              border: "1px solid var(--hairline)",
              background: archivedOpen ? "var(--nav-active)" : "var(--surface)",
              color: "var(--muted)",
              cursor: "pointer",
            }}
          >
            archived · {archivedCards.length}
          </button>
        </div>
      </div>

      {/* board */}
      <div style={{ flex: 1, overflowX: "auto", overflowY: "hidden", padding: "4px 20px 16px" }}>
        <div style={{ display: "flex", gap: 12, height: "100%" }}>
          {orderedBuckets.map((bucket, bi) => {
            const dimmed = bucketFilter != null && bucketFilter !== bucket.id;
            const full = grouped.get(bucket.id) ?? [];
            const visible = filterByOwner(full, ownerFilter);
            const isDropCol = drop != null && dragId != null && drop.bucketId === bucket.id;
            return (
              <div
                key={bucket.id}
                onDragOver={(e) => {
                  if (dragId == null) return;
                  e.preventDefault();
                  setDrop({ bucketId: bucket.id, index: visible.length });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragId != null) {
                    const idx = drop && drop.bucketId === bucket.id ? drop.index : null;
                    void moveCard(dragId, bucket.id, idx);
                  }
                }}
                style={{
                  flex: 1,
                  minWidth: 230,
                  maxWidth: 340,
                  display: "flex",
                  flexDirection: "column",
                  background: "var(--col-bg, var(--surface-alt))",
                  border: `1px solid ${isDropCol ? "var(--accent)" : "transparent"}`,
                  borderRadius: 12,
                  opacity: dimmed ? 0.35 : 1,
                  position: "relative",
                }}
              >
                {/* column header */}
                <div style={{ flex: "none", padding: "9px 9px 6px 13px", display: "flex", alignItems: "center", gap: 8 }}>
                  {renamingId === bucket.id ? (
                    <input
                      autoFocus
                      value={renameText}
                      onChange={(e) => setRenameText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          void renameBucket(bucket.id, renameText);
                          setRenamingId(null);
                        }
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      onBlur={() => setRenamingId(null)}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 12,
                        fontWeight: 600,
                        padding: "3px 7px",
                        border: "1px solid var(--accent)",
                        borderRadius: 6,
                        background: "var(--surface)",
                        color: "var(--ink)",
                        outline: "none",
                      }}
                    />
                  ) : (
                    <span style={{ fontSize: 12, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {bucket.label}
                    </span>
                  )}
                  <span style={{ fontFamily: mono, fontSize: 10.5, color: "var(--faint)" }}>{visible.length}</span>
                  {isAdmin && (
                    <button
                      aria-label="Bucket options"
                      onClick={(e) => {
                        e.stopPropagation();
                        setBucketMenuId(bucketMenuId === bucket.id ? null : bucket.id);
                        setCardMenuId(null);
                      }}
                      style={{ flex: "none", width: 22, height: 22, borderRadius: 6, border: "none", background: bucketMenuId === bucket.id ? "var(--hover, var(--surface))" : "transparent", color: "var(--muted)", cursor: "pointer", fontSize: 13 }}
                    >
                      ⋯
                    </button>
                  )}
                </div>

                {/* bucket menu */}
                {isAdmin && bucketMenuId === bucket.id && (
                  <div style={menuStyle(34)}>
                    <MenuItem label="Rename" onClick={() => { setRenamingId(bucket.id); setRenameText(bucket.label); setBucketMenuId(null); }} />
                    <MenuItem label="← Move left" disabled={bi === 0} onClick={() => void reorderBucket(bucket.id, -1)} />
                    <MenuItem label="Move right →" disabled={bi === orderedBuckets.length - 1} onClick={() => void reorderBucket(bucket.id, 1)} />
                    <MenuItem label="Delete bucket" danger disabled={full.length > 0} onClick={() => void deleteBucket(bucket.id)} />
                    {full.length > 0 && (
                      <div style={{ fontSize: 11, color: "var(--faint)", padding: "5px 10px 6px", lineHeight: 1.45, borderTop: "1px solid var(--hairline)", marginTop: 4 }}>
                        Delete is available once the bucket is empty.
                      </div>
                    )}
                  </div>
                )}

                {/* card list */}
                <div style={{ flex: 1, overflowY: "auto", padding: "2px 9px 10px", display: "flex", flexDirection: "column", gap: 7 }}>
                  {visible.map((card, idx) => {
                    const editable = uiCanEdit(isAdmin, card, myUserId);
                    const prog = checklistProgress(card.checklist);
                    const showIndicator = drop != null && dragId != null && drop.bucketId === bucket.id && drop.index === idx;
                    return (
                      <div key={card.id}>
                        {showIndicator && <DropBar />}
                        <div
                          draggable={editable}
                          tabIndex={0}
                          onDragStart={(e) => {
                            if (!editable) {
                              e.preventDefault();
                              return;
                            }
                            setDragId(card.id);
                            try {
                              e.dataTransfer.setData("text/plain", String(card.id));
                              e.dataTransfer.effectAllowed = "move";
                            } catch {}
                          }}
                          onDragEnd={() => {
                            setDragId(null);
                            setDrop(null);
                          }}
                          onDragOver={(e) => {
                            if (dragId == null) return;
                            e.preventDefault();
                            e.stopPropagation();
                            const r = e.currentTarget.getBoundingClientRect();
                            const before = e.clientY < r.top + r.height / 2;
                            setDrop({ bucketId: bucket.id, index: before ? idx : idx + 1 });
                          }}
                          onClick={() => {
                            if (cardMenuId == null) setDrawerId(card.id);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              setDrawerId(card.id);
                            }
                            if (e.key === "m" || e.key === "M") {
                              e.preventDefault();
                              setCardMenuId(cardMenuId === card.id ? null : card.id);
                            }
                          }}
                          style={{
                            background: "var(--surface)",
                            border: `1px solid ${dragId === card.id ? "var(--accent)" : "var(--hairline)"}`,
                            borderRadius: 9,
                            padding: "10px 11px",
                            cursor: editable ? "grab" : "default",
                            position: "relative",
                            opacity: dragId === card.id ? 0.45 : 1,
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                            <div style={{ fontSize: 12.5, fontWeight: 500, lineHeight: 1.35, flex: 1 }}>{card.title}</div>
                            <button
                              aria-label="Move card"
                              onClick={(e) => {
                                e.stopPropagation();
                                setCardMenuId(cardMenuId === card.id ? null : card.id);
                                setBucketMenuId(null);
                              }}
                              style={{ flex: "none", width: 20, height: 20, margin: "-3px -4px 0 0", borderRadius: 5, border: "none", background: cardMenuId === card.id ? "var(--hover, var(--surface-alt))" : "transparent", color: "var(--faint)", cursor: "pointer", fontSize: 12 }}
                            >
                              ⋯
                            </button>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 8, flexWrap: "wrap" }}>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                              <Avatar name={card.ownerName} />
                              <span style={{ fontSize: 11, color: "var(--muted)" }}>{card.ownerName ?? "Unassigned"}</span>
                            </span>
                            {card.docSlug && (
                              <span style={{ fontFamily: mono, fontSize: 10, padding: "1px 6px", borderRadius: 5, background: "var(--accent-ring, rgba(46,107,79,0.07))", color: "var(--accent)", border: "1px solid var(--accent)", maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {card.docSlug}
                              </span>
                            )}
                            <span style={{ flex: 1 }} />
                            {prog.total > 0 && <span style={{ fontFamily: mono, fontSize: 10, color: "var(--muted)" }}>{prog.label}</span>}
                            {!editable && (
                              <span title="Owned by someone else — members move only their own cards" style={{ fontFamily: mono, fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase", padding: "1px 6px", borderRadius: 4, background: "var(--surface-alt)", color: "var(--faint)" }}>
                                view
                              </span>
                            )}
                          </div>
                          {prog.total > 0 && (
                            <div style={{ marginTop: 8, height: 3, borderRadius: 2, background: "var(--hairline)", overflow: "hidden" }}>
                              <div style={{ height: "100%", width: `${prog.percent}%`, background: "var(--accent)", borderRadius: 2 }} />
                            </div>
                          )}

                          {/* move-to menu */}
                          {cardMenuId === card.id && (
                            <div style={menuStyle(26)}>
                              <div style={{ fontFamily: mono, fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--faint)", padding: "5px 10px 3px" }}>move to…</div>
                              {orderedBuckets.filter((x) => x.id !== bucket.id).map((x) => (
                                <MenuItem key={x.id} label={x.label} disabled={!editable} onClick={() => void moveCard(card.id, x.id, null)} />
                              ))}
                              <MenuItem label="Archive" disabled={!editable} onClick={() => { void archiveCard(card.id, true); setCardMenuId(null); }} />
                              {!editable && (
                                <div style={{ fontSize: 11, color: "var(--faint)", padding: "5px 10px 6px", lineHeight: 1.45, borderTop: "1px solid var(--hairline)", marginTop: 4 }}>
                                  Owned by {card.ownerName ?? "someone else"} — members move only their own cards.
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {isDropCol && drop != null && drop.index >= visible.length && <DropBar />}

                  {visible.length === 0 && !isDropCol && (
                    <div style={{ border: "1px dashed var(--hairline)", borderRadius: 9, padding: "18px 10px", textAlign: "center", fontSize: 11.5, color: "var(--faint)" }}>
                      no cards
                    </div>
                  )}

                  {/* per-column composer */}
                  {composerBucketId === bucket.id ? (
                    <div style={{ background: "var(--surface)", border: "1px solid var(--accent)", borderRadius: 9, padding: "8px 9px" }}>
                      <input
                        autoFocus
                        value={composerText}
                        onChange={(e) => setComposerText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") setComposerBucketId(null);
                          if (e.key === "Enter") {
                            void createCard(bucket.id, composerText);
                            setComposerText("");
                          }
                        }}
                        onBlur={() => setComposerBucketId(null)}
                        placeholder="Card title — Enter to add, Esc to cancel"
                        style={{ width: "100%", fontSize: 12.5, border: "none", background: "transparent", color: "var(--ink)", outline: "none" }}
                      />
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setComposerBucketId(bucket.id);
                        setComposerText("");
                      }}
                      style={{ flex: "none", textAlign: "left", fontSize: 12, color: "var(--faint)", padding: "7px 11px", border: "none", borderRadius: 9, background: "none", cursor: "pointer" }}
                    >
                      + New card
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {/* add bucket */}
          {isAdmin && (
            <div style={{ flex: "none", width: 200 }}>
              {addingBucket ? (
                <div style={{ background: "var(--col-bg, var(--surface-alt))", border: "1px solid var(--accent)", borderRadius: 12, padding: 10 }}>
                  <input
                    autoFocus
                    value={newBucketText}
                    onChange={(e) => setNewBucketText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setAddingBucket(false);
                      if (e.key === "Enter") {
                        void createBucket(newBucketText);
                        setAddingBucket(false);
                      }
                    }}
                    onBlur={() => setAddingBucket(false)}
                    placeholder="Bucket name…"
                    style={{ width: "100%", fontSize: 12, fontWeight: 600, padding: "5px 8px", border: "1px solid var(--hairline)", borderRadius: 7, background: "var(--surface)", color: "var(--ink)", outline: "none" }}
                  />
                  <div style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 6 }}>Enter to add · Esc to cancel</div>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setAddingBucket(true);
                    setNewBucketText("");
                  }}
                  style={{ width: "100%", textAlign: "left", fontSize: 12, fontWeight: 500, color: "var(--faint)", padding: "11px 13px", border: "1px dashed var(--hairline)", borderRadius: 12, background: "none", cursor: "pointer" }}
                >
                  + New bucket
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* archived strip */}
      {archivedOpen && (
        <div style={{ flex: "none", borderTop: "1px solid var(--hairline)", background: "var(--surface-alt)", padding: "10px 20px 14px" }}>
          <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 8 }}>
            archived · restore puts the card back in its last bucket
          </div>
          <div style={{ display: "flex", gap: 8, overflowX: "auto" }}>
            {archivedCards.length === 0 && <div style={{ fontSize: 12, color: "var(--faint)", padding: "6px 0" }}>Nothing archived.</div>}
            {archivedCards.map((c) => {
              const canRestore = uiCanEdit(isAdmin, c, myUserId);
              return (
                <div key={c.id} style={{ flex: "none", width: 230, background: "var(--surface)", border: "1px solid var(--hairline)", borderRadius: 9, padding: "9px 11px", display: "flex", alignItems: "center", gap: 9 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--muted)" }}>{c.title}</div>
                    <div style={{ fontFamily: mono, fontSize: 10, color: "var(--faint)", marginTop: 2 }}>was in {bucketLabelByKey(c.bucketKey)}</div>
                  </div>
                  {canRestore && (
                    <button onClick={() => void archiveCard(c.id, false)} style={{ flex: "none", fontSize: 11, fontWeight: 500, padding: "4px 9px", borderRadius: 6, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", cursor: "pointer" }}>
                      Restore
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* click-outside layer */}
      {anyMenuOpen && <div onClick={closeMenus} style={{ position: "fixed", inset: 0, zIndex: 40 }} />}

      {/* drawer */}
      {drawerCard && (
        <>
          <div onClick={() => setDrawerId(null)} style={{ position: "fixed", inset: 0, background: "rgba(15,12,9,0.32)", zIndex: 46 }} />
          <aside style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: "min(480px, 94vw)", background: "var(--surface)", borderLeft: "1px solid var(--hairline)", zIndex: 47, display: "flex", flexDirection: "column", boxShadow: "-16px 0 48px rgba(15,12,9,0.18)" }}>
            <div style={{ flex: "none", padding: "18px 22px 14px", borderBottom: "1px solid var(--hairline)" }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: mono, fontSize: 10.5, color: "var(--faint)", marginBottom: 5 }}>
                    card · {bucketLabelByKey(drawerCard.bucketKey).toLowerCase()} · owner {(drawerCard.ownerName ?? "unassigned").toLowerCase()}
                  </div>
                  <h2 style={{ fontSize: 17, fontWeight: 600, margin: 0, lineHeight: 1.3 }}>{drawerCard.title}</h2>
                </div>
                <button onClick={() => setDrawerId(null)} style={{ flex: "none", fontSize: 16, color: "var(--muted)", background: "none", border: "none", cursor: "pointer", padding: 4 }}>✕</button>
              </div>

              {!drawerEditable && (
                <div style={{ marginTop: 12, border: "1px solid var(--hairline)", background: "var(--surface-alt)", borderRadius: 8, padding: "8px 12px", fontSize: 12, color: "var(--muted)" }}>
                  Owned by {drawerCard.ownerName ?? "someone else"}. As a member you can read this card but only edit or move cards you own.
                </div>
              )}

              {/* bucket chips */}
              <ChipRow label="bucket">
                {orderedBuckets.map((b) => (
                  <Chip key={b.id} label={b.label} active={drawerCard.bucketId === b.id} disabled={!drawerEditable} onClick={() => void moveCard(drawerCard.id, b.id, null)} />
                ))}
              </ChipRow>

              {/* owner chips (admin-only) */}
              <ChipRow label="owner">
                <Chip label="Unassigned" active={drawerCard.ownerUserId == null} disabled={!isAdmin} onClick={() => void assignOwner(drawerCard.id, null)} />
                {people.map((p) => (
                  <Chip key={p.id} label={p.name} active={drawerCard.ownerUserId === p.id} disabled={!isAdmin} avatar={p.name} onClick={() => void assignOwner(drawerCard.id, p.id)} />
                ))}
              </ChipRow>

              {/* linked-doc chip */}
              <ChipRow label="linked doc">
                <Chip mono label="none" active={!drawerCard.docSlug} disabled={!drawerEditable} onClick={() => void setDocSlug(drawerCard.id, null)} />
                {drawerCard.docSlug && <Chip mono label={drawerCard.docSlug} active disabled={!drawerEditable} onClick={() => {}} />}
              </ChipRow>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: "18px 22px 28px" }}>
              {drawerCard.body.trim().length > 0 ? (
                <Markdown content={drawerCard.body} register="operator" />
              ) : (
                <div style={{ fontSize: 13, color: "var(--faint)" }}>No description yet.</div>
              )}

              {/* checklist */}
              <div style={{ marginTop: 20 }}>
                <div style={{ fontFamily: mono, fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 8 }}>
                  Checklist · {checklistProgress(drawerCard.checklist).total > 0 ? `${checklistProgress(drawerCard.checklist).done} of ${checklistProgress(drawerCard.checklist).total} done` : "none"}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {drawerCard.checklist.length === 0 && <div style={{ fontSize: 12, color: "var(--faint)" }}>No checklist on this card.</div>}
                  {drawerCard.checklist.map((item, idx) => (
                    <button
                      key={idx}
                      disabled={!drawerEditable}
                      onClick={() => void toggleChecklistItem(drawerCard, idx)}
                      style={{ display: "flex", alignItems: "center", gap: 9, textAlign: "left", background: "none", border: "none", padding: "2px 0", cursor: drawerEditable ? "pointer" : "default" }}
                    >
                      <span style={{ width: 15, height: 15, borderRadius: 4, border: `1.5px solid ${item.done ? "var(--accent)" : "var(--border-strong, var(--hairline))"}`, background: item.done ? "var(--accent)" : "transparent", display: "inline-flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 9, flex: "none" }}>
                        {item.done ? "✓" : ""}
                      </span>
                      <span style={{ fontSize: 13, color: item.done ? "var(--faint)" : "var(--ink)", textDecoration: item.done ? "line-through" : "none" }}>{item.text}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* activity */}
              <div style={{ marginTop: 22 }}>
                <div style={{ fontFamily: mono, fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--faint)", marginBottom: 8 }}>Activity</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, borderLeft: "2px solid var(--hairline)", paddingLeft: 14 }}>
                  {activity.length === 0 && <div style={{ fontSize: 12, color: "var(--faint)" }}>No activity yet.</div>}
                  {[...activity].reverse().map((ev) => (
                    <div key={ev.id}>
                      <div style={{ fontSize: 12.5, lineHeight: 1.45 }}>
                        {activityLine(ev.kind, ev.payload, ev.actorName, bucketLabelByKey)}
                      </div>
                      <div style={{ fontFamily: mono, fontSize: 10, color: "var(--faint)", marginTop: 2 }}>{new Date(ev.createdAt).toLocaleString()}</div>
                    </div>
                  ))}
                </div>
              </div>

              {drawerEditable && drawerCard.archivedAt == null && (
                <button onClick={() => { void archiveCard(drawerCard.id, true); setDrawerId(null); }} style={{ marginTop: 26, fontSize: 12.5, fontWeight: 500, padding: "7px 14px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--muted)", cursor: "pointer" }}>
                  Archive card
                </button>
              )}
            </div>
          </aside>
        </>
      )}
    </div>
  );
}

// ── small presentational helpers ────────────────────────────────────────────

function DropBar() {
  return <div style={{ height: 3, borderRadius: 2, background: "var(--accent)", margin: "-2px 2px", flex: "none" }} />;
}

function Avatar({ name }: { name: string | null }) {
  return (
    <span style={{ width: 18, height: 18, borderRadius: "50%", background: "var(--accent-ring, rgba(46,107,79,0.12))", color: "var(--accent)", fontSize: 9.5, fontWeight: 600, display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
      {ownerInitial(name)}
    </span>
  );
}

function menuStyle(top: number): React.CSSProperties {
  return {
    position: "absolute",
    top,
    right: 8,
    zIndex: 45,
    width: 200,
    background: "var(--surface)",
    border: "1px solid var(--hairline)",
    borderRadius: 10,
    boxShadow: "0 12px 32px rgba(15,12,9,0.18)",
    padding: 5,
  };
}

function MenuItem({ label, onClick, disabled, danger }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        fontSize: 12.5,
        padding: "7px 10px",
        border: "none",
        borderRadius: 7,
        background: "none",
        color: disabled ? "var(--faint)" : danger ? "var(--danger-ink, #9C4A3C)" : "var(--ink)",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {label}
    </button>
  );
}

function FilterGroup({ label, chips, active, onPick }: { label: string; chips: { id: number | null; label: string }[]; active: number | null; onPick: (id: number | null) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--faint)" }}>{label}</span>
      {chips.map((c) => {
        const on = active === c.id;
        return (
          <button
            key={String(c.id)}
            onClick={() => onPick(c.id)}
            style={{ fontSize: 12, fontWeight: 500, padding: "4px 11px", borderRadius: 99, border: `1px solid ${on ? "var(--accent)" : "var(--hairline)"}`, background: on ? "var(--accent-ring, rgba(46,107,79,0.09))" : "var(--surface)", color: on ? "var(--accent)" : "var(--muted)", cursor: "pointer" }}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

function ChipRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--faint)" }}>{label}</span>
      {children}
    </div>
  );
}

function Chip({ label, active, disabled, onClick, avatar, mono }: { label: string; active: boolean; disabled?: boolean; onClick: () => void; avatar?: string; mono?: boolean }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontFamily: mono ? "var(--font-mono)" : "inherit",
        fontSize: mono ? 10.5 : 11,
        fontWeight: 500,
        padding: avatar ? "3px 9px 3px 4px" : "3px 9px",
        borderRadius: mono ? 6 : 99,
        border: `1px solid ${active ? "var(--accent)" : "var(--hairline)"}`,
        background: active ? "var(--accent-ring, rgba(46,107,79,0.09))" : "transparent",
        color: active ? "var(--accent)" : disabled ? "var(--faint)" : "var(--muted)",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {avatar && <Avatar name={avatar} />}
      {label}
    </button>
  );
}
