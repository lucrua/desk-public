import { headers } from "next/headers";
import Link from "next/link";
import { getPrincipal } from "@/lib/auth";
import {
  HELP_SECTIONS,
  isSectionAdminTagged,
  isSectionVisible,
  type HelpSection,
  type Role,
} from "./sections";
import HelpNav from "./HelpNav";

export const dynamic = "force-dynamic";

// ── shared inline styles (operator register; mirrors /me + /docs idiom) ───────
const sectionStyle = { margin: "0 0 44px", scrollMarginTop: 70 } as const;

const h2Style = {
  fontSize: 17,
  fontWeight: 600,
  letterSpacing: "-0.01em",
  margin: "0 0 12px",
  display: "flex",
  alignItems: "center",
  gap: 10,
} as const;

const pStyle = {
  margin: "0 0 12px",
  fontSize: 13.5,
  lineHeight: 1.62,
  color: "var(--ink)",
} as const;

const mutedP = { ...pStyle, color: "var(--muted)" } as const;

const labelStyle = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.06em",
  textTransform: "uppercase" as const,
  color: "var(--faint)",
} as const;

const cardStyle = {
  border: "1px solid var(--hairline)",
  borderRadius: 12,
  background: "var(--surface)",
  padding: "16px 20px",
  margin: "0 0 12px",
} as const;

const codeBlock = {
  margin: "0 0 12px",
  padding: "14px 16px",
  background: "var(--code-bg)",
  color: "var(--code-ink)",
  border: "1px solid var(--hairline)",
  borderRadius: 8,
  overflowX: "auto" as const,
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  lineHeight: 1.6,
  whiteSpace: "pre" as const,
} as const;

function code(text: string): React.ReactNode {
  return (
    <code
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.86em",
        background: "var(--code-bg)",
        color: "var(--code-ink)",
        padding: "1px 5px",
        borderRadius: 4,
      }}
    >
      {text}
    </code>
  );
}

function AdminTag() {
  return (
    <span
      title="This action is available to the workspace admin only."
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 9.5,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        padding: "2px 7px",
        borderRadius: 999,
        border: "1px solid var(--ref-border)",
        background: "var(--ref-bg)",
        color: "var(--ref-ink)",
      }}
    >
      admin
    </span>
  );
}

function SectionHeading({ section, role }: { section: HelpSection; role: Role }) {
  return (
    <h2 id={section.id} style={h2Style}>
      {section.title}
      {isSectionAdminTagged(section, role) && <AdminTag />}
    </h2>
  );
}

// Render a section only if visible for the role; otherwise nothing.
function Section({
  id,
  role,
  children,
}: {
  id: string;
  role: Role;
  children: React.ReactNode;
}) {
  const section = HELP_SECTIONS.find((s) => s.id === id)!;
  if (!isSectionVisible(section, role)) return null;
  return (
    <section style={sectionStyle}>
      <SectionHeading section={section} role={role} />
      {children}
    </section>
  );
}

const ExtLink = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a
    href={href}
    target="_blank"
    rel="noreferrer"
    style={{ color: "var(--link-ink)", textDecoration: "underline", textUnderlineOffset: 2 }}
  >
    {children}
  </a>
);

const InLink = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <Link href={href} style={{ color: "var(--accent)", textDecoration: "none" }}>
    {children}
  </Link>
);

export default async function HelpPage() {
  const principal = await getPrincipal(await headers());
  // Layout already blocks anonymous; principal is admin | member here.
  const role: Role = principal.kind === "admin" ? "admin" : "member";
  const name = principal.kind !== "anonymous" ? principal.name : "you";
  const visible = HELP_SECTIONS.filter((s) => isSectionVisible(s, role));

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "32px 20px 96px" }}>
      <header style={{ marginBottom: 8 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.01em", margin: "0 0 6px" }}>
          Help
        </h1>
        <p style={{ ...mutedP, margin: 0 }}>
          How Desk works and how to use it — publishing, sharing, comments, and
          connecting an agent over MCP. This page adapts to your role; you are
          reading it as{" "}
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              padding: "1px 8px",
              borderRadius: 999,
              border: "1px solid var(--hairline)",
              background: "var(--surface-alt)",
              color: "var(--muted)",
            }}
          >
            {name} · {role}
          </span>
          .
        </p>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr)",
          gap: 32,
          marginTop: 24,
          // Two columns on wide viewports: sticky TOC + content.
        }}
      >
        <div className="help-grid">
          <aside className="help-toc">
            <HelpNav sections={visible} />
          </aside>

          <div className="help-body" style={{ minWidth: 0 }}>
            {/* ── What is Desk ─────────────────────────────────────────── */}
            <Section id="what-is-desk" role={role}>
              <p style={pStyle}>
                Desk is a self-hosted workspace for publishing documents and
                sharing them with stable, revocable links. It runs as one app
                behind <strong>two front doors</strong>:
              </p>
              <div style={cardStyle}>
                <div style={{ ...labelStyle, marginBottom: 6 }}>the wall</div>
                <p style={{ ...pStyle, margin: 0 }}>
                  The operator workspace (where you are now) sits behind a
                  Cloudflare Access login wall. Only approved staff — the single
                  admin and members — can reach it. This is where docs are read,
                  organized, commented on, and (for the admin) published and
                  managed.
                </p>
              </div>
              <div style={cardStyle}>
                <div style={{ ...labelStyle, marginBottom: 6 }}>the links</div>
                <p style={{ ...pStyle, margin: 0 }}>
                  A separate no-login share surface. A <em>capability link</em>{" "}
                  is a long, unguessable URL that grants read access to one doc —
                  no account needed. Anyone with the link can read (and, if
                  enabled, comment). Links are revocable, logged, and can carry
                  an expiry.
                </p>
              </div>
              <p style={mutedP}>
                Nothing in Desk is publicly indexable, and source files are never
                exposed directly. Unpublishing a doc instantly kills its page and
                every link that points to it.
              </p>
            </Section>

            {/* ── Reading & visibility ─────────────────────────────────── */}
            <Section id="reading" role={role}>
              <p style={pStyle}>
                A doc lives inside a <strong>space</strong> (a git repo Desk
                hosts), and visibility is set on the space. You see a doc when:
                you&rsquo;re the <strong>admin</strong>; you&rsquo;re a{" "}
                <strong>member</strong> of its space; the space&rsquo;s visibility
                is <strong>public</strong> or <strong>unlisted</strong>; or
                someone shared a <strong>capability link</strong> with you. A
                space&rsquo;s visibility and membership are managed on the space
                itself — see <a href="#spaces" style={{ color: "var(--accent)", textDecoration: "none" }}>Spaces &amp; git</a>.
              </p>
              <p style={pStyle}>
                Docs can also live in <strong>folders</strong> — a simple path
                like {code("os/canon")} shown inside a space as collapsible
                groups. Folders are organizational only: they don&rsquo;t change
                who can see a doc (that&rsquo;s the space) or its identity
                (that&rsquo;s the slug). The doc list can be filtered to a folder
                with {code("?path=os")}.
              </p>
              <ul style={{ ...pStyle, paddingLeft: 20 }}>
                <li style={{ marginBottom: 6 }}>
                  <strong>Members</strong> see published docs in spaces they
                  belong to (plus any public/unlisted space), can comment on them,
                  and can view their own account at{" "}
                  <InLink href="/me">/me</InLink>.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>The admin</strong> sees every doc — including
                  unpublished drafts and docs in private spaces — plus the admin
                  dashboard, where spaces and membership are managed.
                </li>
              </ul>
              <p style={mutedP}>
                On any doc page, <strong>Copy source</strong> puts the current
                version&rsquo;s source on your clipboard and{" "}
                <strong>Download</strong> saves it as a file ({code(".md")} or{" "}
                {code(".html")}). Share-link readers get the same two actions in
                their header.
              </p>
              <p style={mutedP}>
                An {code(".html")} doc renders in a <strong>sandboxed preview</strong>{" "}
                — use the <strong>Rendered / Source</strong> toggle above it to flip
                between the live page and the raw HTML. The preview runs in an
                isolated frame, so artifact scripts can never reach Desk&rsquo;s
                session or data. Readers of a shared {code(".html")} see the same
                sandboxed render.
              </p>
              <div
                style={{
                  ...cardStyle,
                  background: "var(--surface-alt)",
                }}
              >
                <div style={{ ...labelStyle, marginBottom: 6 }}>your role</div>
                <p style={{ ...pStyle, margin: 0 }}>
                  {role === "admin" ? (
                    <>
                      You are the <strong>admin</strong>. You see everything and
                      can publish, share, and manage users, spaces, and
                      membership. Members see a doc only when they&rsquo;re in its
                      space, or the space is public/unlisted.
                    </>
                  ) : (
                    <>
                      You are a <strong>member</strong>. You can read docs in
                      spaces you belong to (plus any public/unlisted space) and
                      comment on them. Publishing, sharing, and user management
                      are admin-only — those sections are hidden from this page
                      for you.
                    </>
                  )}
                </p>
              </div>
            </Section>

            {/* ── Search ───────────────────────────────────────────────── */}
            <Section id="search" role={role}>
              <p style={pStyle}>
                The search box on <InLink href="/spaces">/spaces</InLink> runs a{" "}
                <strong>full-text search</strong> over every doc&rsquo;s title
                and current content — not just a title/slug filter. Results are
                <strong> ranked by relevance</strong> (a title match outranks a
                body match) and each row shows a short snippet with the matched
                words <mark style={{ background: "var(--accent-ring)", color: "var(--ink)", borderRadius: 3, padding: "0 2px" }}>highlighted</mark>.
              </p>
              <ul style={{ ...pStyle, paddingLeft: 20 }}>
                <li style={{ marginBottom: 6 }}>
                  <strong>Query syntax.</strong> Type bare words to match all of
                  them, {code(`"a quoted phrase"`)} for an exact phrase, or{" "}
                  {code("-word")} to exclude a term.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>Scope.</strong> Search only ever returns docs you can
                  already see — members see docs in spaces they belong to, plus
                  public/unlisted spaces; the admin sees everything (including
                  unpublished). It respects the same boundaries as the rest of
                  Desk.
                </li>
              </ul>
              <p style={mutedP}>
                Agents get the same search over MCP: {code("search_docs")}{" "}
                returns ranked results with snippets, and {code("list_docs")}{" "}
                with a {code("q")} runs the same full-text search. Both are
                space-scoped exactly like the browser.
              </p>
            </Section>

            {/* ── Publishing (admin) ───────────────────────────────────── */}
            <Section id="publishing" role={role}>
              <p style={pStyle}>
                Publishing is a deliberate act: a published doc gets a stable hub
                page and can be shared. There are three ways to publish, all
                equivalent — pick whatever fits your workflow:
              </p>
              <ul style={{ ...pStyle, paddingLeft: 20 }}>
                <li style={{ marginBottom: 6 }}>
                  <strong>Push to a space</strong> — commit a Markdown or HTML
                  file and {code("git push")} it to the space&rsquo;s repo. Desk
                  re-renders the changed paths within seconds. This is the primary
                  path; see <a href="#spaces" style={{ color: "var(--accent)", textDecoration: "none" }}>Spaces &amp; git</a>.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>The {code("desk")} CLI</strong> — {code("desk publish ./file.md")}{" "}
                  from your terminal. See the <a href="#cli" style={{ color: "var(--accent)", textDecoration: "none" }}>CLI</a> section.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>The MCP API</strong> — an agent calls the{" "}
                  {code("publish_doc")} tool. See{" "}
                  <a href="#mcp" style={{ color: "var(--accent)", textDecoration: "none" }}>Connecting an agent</a>.
                </li>
              </ul>
              <p style={mutedP}>
                Re-publishing the same slug updates the doc in place. Unpublishing
                it (from /admin or via the CLI / MCP) takes the page down and
                revokes every link instantly. A doc&rsquo;s page has a{" "}
                <strong>Move…</strong> action to re-file it into another folder
                later (folders are organizational only — they never change
                visibility).
              </p>
            </Section>

            {/* ── Doc ownership ────────────────────────────────────────── */}
            <Section id="ownership" role={role}>
              <p style={pStyle}>
                Every doc has an <strong>owner</strong> — the staff member who
                created it. The owner can publish new versions directly (no
                approval needed), and can accept or reject revision proposals
                on their doc — just like an admin can for any doc.
              </p>
              <ul style={{ ...pStyle, paddingLeft: 20 }}>
                <li style={{ marginBottom: 6 }}>
                  <strong>Creator = owner.</strong> When you publish a new doc
                  (push to a space, CLI {code("desk publish")}, or MCP{" "}
                  {code("publish_doc")}), the doc&rsquo;s owner is automatically
                  set to you. Existing docs created before ownership was
                  introduced have no owner ({code("null")}) — they behave as
                  admin-only until an admin assigns one.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>What the owner can do.</strong> On any doc they own:
                  publish a new version directly via Edit (saves immediately —
                  no approval queue) or by pushing to the space, and accept or
                  reject revision proposals from other members.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>What the owner cannot do.</strong> Create brand-new
                  docs from scratch, delete or unpublish docs, manage shares,
                  move docs, or change a space&rsquo;s visibility — those remain
                  admin-only.
                </li>
                {role === "admin" && (
                  <li style={{ marginBottom: 6 }}>
                    <strong>Reassigning (admin).</strong> Open a doc, then{" "}
                    {code("⋯")} → <strong>Set owner…</strong> and enter the new
                    owner&rsquo;s numeric user ID (find IDs in{" "}
                    <InLink href="/admin">/admin → Users</InLink>). Over MCP:{" "}
                    {code("set_doc_owner")}.
                  </li>
                )}
              </ul>
              <p style={mutedP}>
                The owner&rsquo;s display name appears in the doc header near
                the action cluster. When a doc has no owner (null), only the
                admin can publish new versions to it.
              </p>
            </Section>

            {/* ── Sharing (admin) ──────────────────────────────────────── */}
            <Section id="sharing" role={role}>
              <p style={pStyle}>
                There are two ways to share a doc:
              </p>
              <ul style={{ ...pStyle, paddingLeft: 20 }}>
                <li style={{ marginBottom: 6 }}>
                  <strong>Inside Desk — add them to the space.</strong> To let a
                  teammate with a Desk account see a doc, add them to the
                  doc&rsquo;s <strong>space</strong> as a member (or make the
                  space <strong>unlisted</strong> / <strong>public</strong>) — set
                  on the space at <a href="#spaces" style={{ color: "var(--accent)", textDecoration: "none" }}>/spaces/[slug]</a>. No link required.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>Outside Desk — a capability link.</strong> For people
                  without a Desk account, create a share link (below) from the
                  doc&rsquo;s <strong>Sharing</strong> panel.
                </li>
              </ul>
              <p style={pStyle}>
                A <strong>share link</strong> is a capability URL: a long random
                token in the URL <em>is</em> the credential. Anyone with the link
                reads the doc — no login, no account. Create one from the Sharing
                panel or from <InLink href="/admin">/admin</InLink>.
              </p>
              <ul style={{ ...pStyle, paddingLeft: 20 }}>
                <li style={{ marginBottom: 6 }}>
                  <strong>One-time URL (retrievable).</strong> The full link is
                  shown on creation with a copy button. It can also be{" "}
                  <strong>retrieved later</strong> via the {code("copy")} button
                  in the share panel or the Distribution view — as long as the link
                  is active and was created after encryption was enabled (older links
                  show {code("—")} on the copy button). See{" "}
                  <a href="#link-lifecycle" style={{ color: "var(--accent)", textDecoration: "none" }}>Link lifecycle</a>.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>Label.</strong> Each link has a human label (e.g.
                  &ldquo;Partner review&rdquo;) — optional; auto-named from the
                  doc title or folder name when omitted.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>Expiry.</strong> Links default to{" "}
                  <strong>7 days</strong>; set a longer window or choose
                  &ldquo;Never&rdquo; for a non-expiring link. Expired links
                  show a friendly expiry notice to the recipient (not a plain
                  404), so they know the link was once valid.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>Live or pinned.</strong> A link normally shows the{" "}
                  <em>latest</em> version — it follows updates. Or pin it to a
                  specific version so the recipient always sees exactly what you
                  sent, even after you publish a newer one. Pinned links carry a{" "}
                  📌 marker in the per-doc share panel. (Unpublishing the doc
                  still kills pinned links — unpublish always wins.)
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>Comments toggle.</strong> Per link, allow or disallow
                  visitor comments on the share page.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>View log.</strong> Each link tracks a view count and
                  last-viewed time, visible in the admin share log.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>Link previews.</strong> When shared on social or
                  messaging apps, links unfurl with the doc title and an
                  auto-excerpt preview.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>Revoke &amp; Delete (two stages).</strong> Revoking a
                  link (stage 1) makes it return 404 immediately — the row stays
                  listed so you have a record. Once revoked, a{" "}
                  {code("delete")} button appears: stage 2 permanently removes it
                  from all lists. Unpublishing the doc revokes all of its links at
                  once. See{" "}
                  <a href="#link-lifecycle" style={{ color: "var(--accent)", textDecoration: "none" }}>Link lifecycle</a>{" "}
                  for the full two-stage flow.
                </li>
              </ul>
              <p style={mutedP}>
                The share reader gives visitors two quiet actions in the header:{" "}
                <strong>Copy</strong> (copies the document source — markdown for
                md docs, HTML for html artifacts) and <strong>Download</strong>{" "}
                (saves the file). Download is served by the same capability route
                as the page, so revoked / expired links return 404 there too.
              </p>
              <p style={pStyle}>
                <strong>Folder shares.</strong> A capability link can also cover a
                whole <em>folder</em>. From a{" "}
                <InLink href="/spaces">space</InLink>&rsquo;s doc tree, use{" "}
                <strong>Share folder…</strong> on a folder row to mint
                one link to every <em>published</em> doc under that path. The
                visitor opens an index and reads each doc under the same token;{" "}
                newly-published docs in the folder appear automatically, and one
                revoke kills the lot. Folder shares are live-only (no pin), the
                comments toggle applies folder-wide, and they list in the{" "}
                <strong>Folder shares</strong> section with a{" "}
                {code("folder · finance/")} chip. Create one over MCP with{" "}
                {code("create_directory_share")}.
              </p>
            </Section>

            {/* ── Link lifecycle (admin) ───────────────────────────────── */}
            <Section id="link-lifecycle" role={role}>
              <p style={pStyle}>
                Share links have a two-stage lifecycle. The stages are{" "}
                <strong>distinct</strong> actions — revoke first, then delete if
                you want the record gone.
              </p>
              <ul style={{ ...pStyle, paddingLeft: 20 }}>
                <li style={{ marginBottom: 6 }}>
                  <strong>Copy link.</strong> Every link created after encryption
                  was enabled has a {code("copy")} button in the share panel and
                  the distribution view. It calls {code("GET /api/shares/[id]/reveal")}
                  (or {code("reveal_share")} over MCP) and copies the same URL that
                  was shown at creation time. Links created before encryption was
                  enabled show a {code("—")} — their URL is not recoverable, but
                  they still work for anyone who already has the link.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>Stage 1 — Revoke.</strong> The {code("revoke")} button
                  makes the link return 404 immediately. The row stays visible in
                  the list (dimmed), so you have a record it existed. Revoke is
                  reversible only by re-creating a link; there is no un-revoke.
                  Over MCP: {code("revoke_share")}.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>Stage 2 — Delete.</strong> Once a link is revoked (or
                  expired), the {code("delete")} button appears in its place.
                  Deleting permanently removes the row from every list — but{" "}
                  <em>the row is kept in the database</em> so comment and view
                  history linked to it stays intact. A delete confirms:
                  &ldquo;Permanently removes this link record.&rdquo; Over MCP:{" "}
                  {code("delete_share")}.
                </li>
              </ul>
              <p style={mutedP}>
                Unpublishing a doc automatically revokes all of its share links
                (stage 1). Completely deleting a doc (see below) also stage-2
                deletes its links. <strong>Expired links</strong> show a
                friendly expiry page to the recipient (not a plain 404), so
                they know the link was once valid and can ask for a fresh one.
                Revoked or deleted links still 404 (no existence signal).
              </p>
            </Section>

            {/* ── Doc lifecycle (admin) ────────────────────────────────── */}
            <Section id="doc-lifecycle" role={role}>
              <p style={pStyle}>
                Docs also have a two-stage lifecycle. The stages are{" "}
                <strong>distinct</strong> — unpublish first (reversible), then
                delete completely (destructive, permanent).
              </p>
              <ul style={{ ...pStyle, paddingLeft: 20 }}>
                <li style={{ marginBottom: 6 }}>
                  <strong>Stage 1 — Unpublish.</strong> The {code("Unpublish")}
                  button on a doc&rsquo;s page de-lists it: members lose access,
                  share links 404, it disappears from search. Version history and
                  content are <em>retained</em>. Re-publishing the same slug
                  restores it in place. Over MCP: {code("unpublish_doc")}.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>Stage 2 — Delete completely.</strong> The{" "}
                  {code("Delete completely…")} button is always available to the
                  admin. It shows a strong confirm:{" "}
                  <em>&ldquo;Purges all content and frees the slug &lt;slug&gt;
                  for reuse. This cannot be undone.&rdquo;</em> After confirmation:
                  the doc is tombstoned, all version content is wiped, every share
                  link for it is stage-2 deleted, and the slug becomes available
                  for a brand-new doc. <strong>This is irreversible</strong> — content
                  is not kept. Over MCP: {code("delete_doc")}.
                </li>
              </ul>
              <p style={mutedP}>
                Slug reuse: if you delete {code("finance/q3")} and later publish a
                new file at the same slug, it is a completely new document with its
                own version chain — the tombstoned history is not resurrected.
                The old and new documents share only the slug.
              </p>
            </Section>

            {/* ── Distribution view (admin) ────────────────────────────── */}
            <Section id="distribution" role={role}>
              <p style={pStyle}>
                The{" "}
                <InLink href="/distribution">Distribution view</InLink> answers
                &ldquo;which files are exposed to whom&rdquo; across your whole
                workspace — admin-only. Three lenses:
              </p>
              <ul style={{ ...pStyle, paddingLeft: 20 }}>
                <li style={{ marginBottom: 6 }}>
                  <strong>By space.</strong> Each space — which users are members
                  of it and which published docs live in it.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>By user.</strong> Each active user — their role, which
                  spaces they can see, and a count of visible docs (members see
                  spaces they belong to plus public/unlisted ones; admins see
                  all).
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>By links &amp; folders.</strong> Every live share link
                  — doc and directory — with its status and the copy / revoke /
                  delete controls from the link lifecycle (above).
                </li>
              </ul>
              <p style={mutedP}>
                Also reachable via MCP: {code("distribution_overview")} returns the
                same three lenses in one call.
              </p>
            </Section>

            {/* ── Comments ─────────────────────────────────────────────── */}
            <Section id="comments" role={role}>
              <p style={pStyle}>
                Every doc carries a comment thread. Comments are plain text /
                Markdown (escaped — no raw HTML), so threads stay safe to render.
              </p>
              <ul style={{ ...pStyle, paddingLeft: 20 }}>
                <li style={{ marginBottom: 6 }}>
                  <strong>On the wall.</strong> Staff (admin and members) comment
                  on a doc&rsquo;s page, and can resolve or hide a thread&rsquo;s
                  resolved items.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>On a share page.</strong> When a link has comments
                  enabled, external visitors can comment too — shown as{" "}
                  {code("via link: <label>")} so it&rsquo;s clear the author came
                  in through a capability link. Visitor comments are
                  rate-limited.
                </li>
              </ul>
              <p style={mutedP}>
                Agents can read and add comments over MCP as well, with the same
                scoping ({code("list_comments")} / {code("add_comment")}).
              </p>
            </Section>

            {/* ── Editing & approvals (all) ────────────────────────────── */}
            <Section id="editing" role={role}>
              <p style={pStyle}>
                Editing a doc goes one of two paths depending on who you are
                relative to that doc:
              </p>
              <ul style={{ ...pStyle, paddingLeft: 20 }}>
                <li style={{ marginBottom: 6 }}>
                  <strong>Owner or admin — direct publish.</strong> Hit{" "}
                  {code("Edit")} on the doc header; the editor opens with the
                  current version. When you save, the new version goes live
                  immediately — no approval, no queue. The button reads{" "}
                  {code("Publish new version")}. You can also publish a new
                  version by pushing to the doc&rsquo;s space.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>Member (no ownership) — propose edit.</strong> On a
                  doc&rsquo;s page, hit {code("Propose edit")} — a Markdown editor
                  opens, prefilled with the current version. Toggle the live
                  preview, add an optional note, and submit. Readers keep seeing
                  the published version; your edit queues as a proposed revision.
                  (HTML docs have no editor.)
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>Review.</strong> Docs with open proposals surface an{" "}
                  {code("N proposed changes")} pill on their page. The doc&rsquo;s
                  owner <em>or</em> any admin can open a revision to see a unified
                  diff against its base version, then {code("Accept")} (publishes a
                  new version) or {code("Reject")}. If the doc moved on since the
                  proposal, the accept screen warns the base is stale.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>Approval queue.</strong> The{" "}
                  <InLink href="/approvals">Approvals</InLink> page (always
                  visible in the nav, with an open-count badge) lists every open
                  revision you can act on — all docs for an admin, your docs for
                  an owner. Each row shows the doc, proposer, age, and a Review
                  link. The queue solves the findability problem: you no longer
                  have to check each doc separately.
                </li>
              </ul>
              <p style={mutedP}>
                Agents do the same over MCP: {code("propose_revision")} /{" "}
                {code("list_revisions")} / {code("decide_revision")} (now callable
                by owner too, not just admin) / {code("list_open_revisions")}{" "}
                (the queue endpoint — admin sees all, owner sees own).
              </p>
            </Section>

            {/* ── Board ────────────────────────────────────────────────── */}
            <Section id="board" role={role}>
              <p style={pStyle}>
                The <InLink href="/board">Board</InLink> is Desk&rsquo;s internal
                kanban — a staff-only coordination surface (not shared
                externally). Cards live in <strong>buckets</strong>{" "}
                (columns) that start as {code("Backlog")}, {code("In Progress")},{" "}
                {code("Review")}, {code("Done")} but are fully editable data.
              </p>
              <ul style={{ ...pStyle, paddingLeft: 20 }}>
                <li style={{ marginBottom: 6 }}>
                  <strong>Cards</strong> carry a title, an optional owner, a
                  linked doc, a checklist, and a markdown body. Drag a card
                  between or within columns, or use a card&rsquo;s {code("⋯")}{" "}
                  menu (or the {code("M")} key) to move it without a mouse.{" "}
                  {code("Enter")} opens the card drawer.
                </li>
                <li style={{ marginBottom: 6 }}>
                  The drawer shows the body, checklist toggles, the bucket/owner/
                  doc pickers, and an <strong>activity trail</strong> built from
                  the event log (&ldquo;moved Backlog → In Progress&rdquo;).
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>Archived</strong> cards drop into the strip at the
                  bottom; restore puts them back in their last bucket. Filter the
                  board by owner or bucket from the top row.
                </li>
              </ul>
              {role === "admin" ? (
                <p style={pStyle}>
                  <strong>As admin</strong> you can create / rename / reorder /
                  delete buckets (delete is available only once a bucket is
                  empty), create cards in any column, and reassign a card&rsquo;s
                  owner. Everything members can do, plus the bucket controls and
                  owner reassignment.
                </p>
              ) : (
                <p style={pStyle}>
                  <strong>As a member</strong> you can create cards and fully
                  edit, move, check, and archive the cards <em>you own</em>.
                  Cards owned by someone else are read-only — they show a quiet{" "}
                  {code("view")} tag and a disabled move menu; you can still open
                  them to read. Owner reassignment and bucket management are
                  admin-only.
                </p>
              )}
              <p style={mutedP}>
                Agents do the same over MCP — buckets ({code("list_buckets")},{" "}
                {code("create_bucket")}, {code("update_bucket")},{" "}
                {code("delete_bucket")}) and cards ({code("list_cards")},{" "}
                {code("get_card")}, {code("create_card")}, {code("update_card")},{" "}
                {code("move_card")}, {code("assign_card")}, {code("archive_card")})
                — with the same admin-vs-owner rules, and every mutation appends a{" "}
                {code("card.*")}/{code("bucket.*")} event consumers can trigger on.
              </p>
            </Section>

            {/* ── Catalog ──────────────────────────────────────────────── */}
            <Section id="catalog" role={role}>
              <p style={pStyle}>
                The <InLink href="/catalog">Catalog</InLink> is a{" "}
                <strong>projection of a space directory&rsquo;s frontmatter</strong>
                {" "}— not a separate database. Pick a <strong>space</strong> and a{" "}
                <strong>directory</strong>; Desk reads every doc under it and renders
                each doc&rsquo;s YAML frontmatter as rows. A page <em>is</em> a file;
                its metadata <em>is</em> the file&rsquo;s frontmatter. Edit a value by
                editing the doc (then {code("git push")}) — there is no second copy.
              </p>
              <ul style={{ ...pStyle, paddingLeft: 20 }}>
                <li style={{ marginBottom: 6 }}>
                  <strong>Auto mode</strong> (no schema): Desk shows the union of
                  every frontmatter field it finds as a <strong>table</strong>, plus{" "}
                  <strong>board</strong> and <strong>list</strong> views. Group,
                  filter, and sort by any field — those choices are <em>display
                  state</em>, never written back to the files.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>Schema mode</strong>: drop a{" "}
                  {code(".desk.collection.yml")} in the directory declaring{" "}
                  <strong>fields</strong> (types / enums / required) and{" "}
                  <strong>views</strong> (e.g. {code("board: {group_by}")},{" "}
                  {code("table: {columns}")}). Desk reads it from the space&rsquo;s
                  git at the current commit, renders the declared views, and{" "}
                  <strong>validates</strong> every doc — surfacing{" "}
                  <strong>drift</strong> (a missing required field, a value outside
                  an enum) as a visible flag. Invalid docs are flagged, never hidden.
                </li>
                <li style={{ marginBottom: 6 }}>
                  The catalog is <strong>read / render-only</strong> for everyone —
                  it reflects the repo. Web-editing frontmatter values lands later
                  (the web-commit path: edit → commit → re-project).
                </li>
              </ul>
              <p style={mutedP}>
                Agents don&rsquo;t need a catalog tool: the truth is the repo, so an
                agent writes frontmatter the same way it writes any file — commit and
                push, and the projection refreshes. There is no separate catalog
                table to keep in sync — the earlier Desk-authored catalog tables
                were deleted; this projection reads directly from each doc&rsquo;s
                parsed frontmatter.
              </p>
            </Section>

            {/* ── Users & access (admin) ───────────────────────────────── */}
            <Section id="users" role={role}>
              <p style={pStyle}>
                Desk uses a <strong>first-login-admin + multi-admin</strong> model.
                The first CF-verified email to sign in on a fresh deployment is
                automatically seeded as admin — no env var or manual DB seed
                required. From there, any admin can promote or demote other users
                from the Users page (role chip on each row). Multiple admins are
                supported; at least one active admin must always remain (the
                last-admin guard blocks demote/deactivate on the only active admin).
                Service-token agent rows can also be promoted to admin, giving them
                publish rights.
              </p>
              <p style={pStyle}>
                When someone hits the wall without access, they land on a
                &ldquo;pending access&rdquo; screen and their request is recorded.
                In <InLink href="/admin">/admin → Users</InLink> you can:
              </p>
              <ul style={{ ...pStyle, paddingLeft: 20 }}>
                <li style={{ marginBottom: 6 }}>
                  <strong>Approve access requests</strong> — turn a pending
                  request into a member account.
                </li>
                <li style={{ marginBottom: 6 }}>
                  Edit a user&rsquo;s display name or service token, and{" "}
                  <strong>deactivate</strong> a user to cut off access. The token
                  field wants the Cloudflare Access{" "}
                  <strong>Client ID</strong> (the {code("<client-id>.access")}{" "}
                  value from Zero Trust → Access → Service Auth) —{" "}
                  <strong>not</strong> the Client Secret, which goes only in the
                  agent&rsquo;s config. See{" "}
                  <a href="#mcp" style={{ color: "var(--accent)", textDecoration: "none" }}>
                    Connecting an agent
                  </a>{" "}
                  for the full wiring.
                </li>
                <li style={{ marginBottom: 6 }}>
                  <strong>Grant or revoke admin</strong> — click the role chip
                  on any user row to toggle between admin and member. The last
                  active admin cannot be demoted or deactivated (the guard message
                  appears inline). Admins can also grant admin to a service-token
                  (agent) row, giving it publish rights.
                </li>
                <li style={{ marginBottom: 6 }}>
                  Give a user <strong>multiple emails</strong>. A person can own
                  several verified addresses (e.g.{" "}
                  {code("lucas@example.org")} +{" "}
                  {code("lucas@example.net")}) on one account — signing in with{" "}
                  <em>any</em> of them resolves the same identity and the same
                  role. Each user row shows its emails as chips (★ marks the
                  primary/display address); use <strong>+ email</strong> to add
                  one and <strong>×</strong> to remove one. An address belongs to
                  exactly one user — adding one already in use is rejected.
                  You can&rsquo;t remove a person&rsquo;s last email unless they
                  also have a service token (otherwise they&rsquo;d have no way to
                  sign in). When approving an access request, the row&rsquo;s{" "}
                  <strong>add to:</strong> selector lets you attach the email to an{" "}
                  <em>existing</em> user instead of creating a new account — the
                  way to fold a second address into someone&rsquo;s account.
                </li>
                <li style={{ marginBottom: 6 }}>
                  Review the <strong>view log</strong>. Space membership and
                  visibility are managed per space on{" "}
                  <a href="#spaces" style={{ color: "var(--accent)", textDecoration: "none" }}>/spaces/[slug]</a>, not here.
                </li>
              </ul>
            </Section>

            {/* ── Spaces & git ─────────────────────────────────────────── */}
            <Section id="spaces" role={role}>
              <p style={pStyle}>
                A <strong>space</strong> is an owned, access-controlled{" "}
                <strong>git repo that Desk hosts</strong>. It is the unit of
                write/clone access — the security boundary. The files in the
                space&rsquo;s repo are the <strong>source of truth</strong>; what
                you see in Desk (the rendered docs, the catalog, the board) is a{" "}
                <strong>projection</strong> Desk rebuilds from those files. There
                is exactly one copy of every document: editing it means editing
                the file, through any door (a {code("git push")}, or — later — a
                web edit that becomes a commit).
              </p>
              <p style={pStyle}>
                Each member has a role <em>on a space</em>:{" "}
                <strong>reader</strong> (clone/fetch), <strong>writer</strong>{" "}
                (clone + push), or <strong>owner</strong>. Browse your spaces at{" "}
                <a href="/spaces" style={{ color: "var(--accent)", textDecoration: "none" }}>/spaces</a> (open one to manage
                its members and visibility). Programmatically: manage roles from{" "}
                {code("POST /api/spaces/[slug]/members")} or the MCP{" "}
                {code("set_space_member")} tool; list spaces with{" "}
                {code("list_spaces")} / {code("GET /api/spaces")}; create one with{" "}
                {code("create_space")} / {code("POST /api/spaces")}.
              </p>
              <p style={pStyle}>
                <strong>Get a push credential.</strong> Mint a{" "}
                <strong>principal token</strong> at{" "}
                <a href="/settings/tokens" style={{ color: "var(--accent)", textDecoration: "none" }}>/settings/tokens</a>{" "}
                (it is shown <em>once</em> — store it then). Programmatically:{" "}
                {code("POST /api/tokens")} / the MCP {code("create_token")} tool.
                The token is bound to <em>your</em> user and carries your role on
                each space.
              </p>
              <p style={pStyle}>
                <strong>Cloning &amp; pushing.</strong> The git transport is
                HTTPS smart-HTTP at{" "}
                {code("https://<host>/api/git/<owner>/<space>.git")}. Authenticate
                with a <strong>principal token</strong> as the HTTP Basic{" "}
                <em>password</em> (any username):
              </p>
              <div style={codeBlock}>
                {`# clone (reader, writer, or owner)
git clone https://git:<token>@<host>/api/git/<owner>/<space>.git

# push from an existing repo (writer or owner)
git remote add desk https://git:<token>@<host>/api/git/<owner>/<space>.git
git push desk HEAD:main`}
              </div>
              <p style={pStyle}>
                <strong>Desk renders the {code("main")} branch.</strong> It indexes
                only that ref, so always push to it explicitly with{" "}
                {code("HEAD:main")} — a bare {code("git push desk HEAD")} from a
                local {code("master")} branch is accepted by the server but renders
                nothing (the {code("main")} ref never moves). Cloning a fresh space
                gives you a repo already on {code("main")}.
              </p>
              <p style={pStyle}>
                A <strong>reader</strong> token can clone but a push is rejected;
                a <strong>writer</strong> or <strong>owner</strong> token can
                push. A push re-renders the affected docs within seconds (the
                projection re-indexes the changed paths). Access is{" "}
                <strong>fail-closed</strong>: anonymous or no-access on a private
                space returns a uniform 404 — never a hint that the space exists.
              </p>
              <p style={pStyle}>
                <strong>Recovery.</strong> The projection is always rebuildable
                from the repo. If it drifts, re-project a space with{" "}
                {code("POST /api/spaces/[slug]/reindex")} (admin only). The bare
                repos under {code("DESK_DATA_DIR")} are the canon — back them up
                off-box.
              </p>
            </Section>

            {/* ── Connecting an agent (MCP) ────────────────────────────── */}
            <Section id="mcp" role={role}>
              <p style={pStyle}>
                Desk exposes a <strong>Model Context Protocol</strong> server so
                agents (Claude Code and others) can call Desk directly. It speaks
                the MCP <strong>Streamable HTTP</strong> transport and reuses the
                same auth and authorization as the rest of the app: members get
                read-only, space-scoped access; mutations are admin-only.
              </p>
              <div style={cardStyle}>
                <div style={{ ...labelStyle, marginBottom: 6 }}>endpoint</div>
                <p style={{ ...pStyle, margin: 0 }}>
                  {code("https://<hub-host>/mcp")} — the same host as this
                  workspace, behind the same Cloudflare Access wall.{" "}
                  <strong>MCP is the agent surface; REST is the UI surface</strong>{" "}
                  — deliberately not 1:1. There are 43 tools covering what an
                  agent actually drives — docs and versions ({code("list_docs")},{" "}
                  {code("search_docs")}, {code("get_doc")}, {code("get_version")},{" "}
                  {code("publish_doc")}, {code("update_doc")}{" "}
                  (move / reassign owner), {code("unpublish_doc")},{" "}
                  {code("delete_doc")}), the event log
                  ({code("list_events")}), shares ({code("create_share")},{" "}
                  {code("create_directory_share")}, {code("list_shares")},{" "}
                  {code("list_doc_shares")},{" "}
                  {code("revoke_share")}, {code("reveal_share")},{" "}
                  {code("delete_share")}), distribution{" "}
                  ({code("distribution_overview")}), comments ({code("list_comments")},{" "}
                  {code("add_comment")}, {code("resolve_comment")},{" "}
                  {code("delete_comment")}), revisions ({code("propose_revision")},{" "}
                  {code("list_revisions")}, {code("decide_revision")},{" "}
                  {code("list_open_revisions")}), the board — cards ({" "}
                  {code("list_buckets")}, {code("list_cards")}, {code("get_card")},{" "}
                  {code("create_card")}, {code("update_card")}, {code("move_card")},{" "}
                  {code("assign_card")}, {code("archive_card")}),
                  spaces and membership ({code("list_spaces")}, {code("create_space")},{" "}
                  {code("set_space_member")}, {code("create_invite")}), proposals (PR review:{" "}
                  {code("list_proposals")}, {code("decide_proposal")}), principal tokens ({" "}
                  {code("create_token")}, {code("list_tokens")},{" "}
                  {code("revoke_token")}),
                  plus {code("whoami")}.
                </p>
                <p style={{ ...mutedP, marginTop: 10, marginBottom: 0 }}>
                  Pure web-UI admin actions are <strong>REST-only</strong> (no MCP
                  tool): user &amp; multi-email management, access-request triage,
                  board-bucket lifecycle (create / rename / delete a column), and a
                  share&rsquo;s view-log / comment-toggle. An agent that needs the
                  &ldquo;who can see what&rdquo; audit uses{" "}
                  {code("distribution_overview")} + {code("list_shares")}.
                </p>
              </div>

              {role === "admin" ? (
                <>
                  <p style={pStyle}>
                    <strong>Setup (admin).</strong> An agent authenticates with a
                    Cloudflare Access <em>service token</em>. Wire it up once:
                  </p>
                  <ol style={{ ...pStyle, paddingLeft: 20 }}>
                    <li style={{ marginBottom: 6 }}>
                      In Cloudflare Zero Trust → <strong>Access → Service Auth</strong>,
                      create a service token. Cloudflare shows a{" "}
                      <strong>Client ID</strong> and a <strong>Client Secret</strong>{" "}
                      (the secret is shown once).
                    </li>
                    <li style={{ marginBottom: 6 }}>
                      Add a <strong>Service-Auth policy</strong> on the Desk
                      Access application that includes that token, so requests
                      carrying it are allowed through the wall.
                    </li>
                    <li style={{ marginBottom: 6 }}>
                      In Desk{" "}
                      <InLink href="/admin">/admin → Users</InLink>, create or
                      edit a user and paste the token&rsquo;s{" "}
                      <strong>Client ID</strong> (the {code("<client-id>.access")}{" "}
                      value — <em>not</em> the Client Secret) into the token field.
                      The JWT&rsquo;s {code("common_name")} claim maps to that user,
                      giving the agent that user&rsquo;s role (member or admin).
                    </li>
                    <li style={{ marginBottom: 6 }}>
                      Add the server to the agent&rsquo;s config:
                    </li>
                  </ol>
                  <div style={codeBlock}>
{`claude mcp add desk --transport http https://<hub-host>/mcp \\
  --header "CF-Access-Client-Id: <id>" \\
  --header "CF-Access-Client-Secret: <secret>"`}
                  </div>
                  <ol start={5} style={{ ...pStyle, paddingLeft: 20 }}>
                    <li style={{ marginBottom: 6 }}>
                      Verify with the {code("whoami")} tool — it returns the
                      resolved principal, confirming the token is wired to the
                      right user.
                    </li>
                  </ol>
                  <div
                    style={{
                      ...cardStyle,
                      background: "var(--warn-bg)",
                      borderColor: "var(--warn-border)",
                    }}
                  >
                    <p style={{ ...pStyle, margin: 0, color: "var(--warn-ink)" }}>
                      <strong>The Client Secret never goes into Desk.</strong> It
                      lives only in the agent&rsquo;s config. Desk only ever stores
                      the Client ID, which it maps to a user.
                    </p>
                  </div>
                </>
              ) : (
                <p style={mutedP}>
                  Connecting an agent requires a Cloudflare Access service token,
                  which the workspace admin provisions and maps to your account.
                  Ask the admin to wire one up; once it&rsquo;s mapped to you, the
                  agent gets your member-scoped read access. The full setup steps
                  are admin-only.
                </p>
              )}
            </Section>

            {/* ── CLI ──────────────────────────────────────────────────── */}
            <Section id="cli" role={role}>
              <p style={pStyle}>
                The zero-dependency {code("desk")} CLI publishes docs, mints and
                revokes share links, and checks drift between local files and what
                is published.
              </p>
              <div style={codeBlock}>
{`desk publish ~/docs/overview.md              # publish a doc
desk share overview --label "Partner review" --expires 7
desk revoke "Partner review"
desk list
desk status`}
              </div>
              <p style={mutedP}>
                It authenticates the same way as everything else — a Cloudflare
                Access service token in production, or the dev role in local dev.
                Full commands and setup live in{" "}
                <ExtLink href="https://github.com/lucrua/desk-public/blob/main/cli/README.md">
                  cli/README.md
                </ExtLink>{" "}
                on GitHub.
              </p>
            </Section>

            {/* ── Syncing local files ──────────────────────────────────── */}
            <Section id="syncing" role={role}>
              <p style={pStyle}>
                {code("desk sync")} keeps a local file (or a whole folder) in
                step with its cloud doc. You <strong>link</strong> a slug to a
                local path once; after that, {code("desk sync")} converges the two
                in either direction — local edits go up, cloud edits come down,
                and edits on both sides are merged. The cloud copy is the canon:
                identity is the slug, and each machine keeps its own private local
                path.
              </p>
              <div style={codeBlock}>
{`desk sync link overview ~/docs/overview.md   # map a slug ↔ a local file
desk sync                                    # converge everything
desk sync status                             # what would change, per file
desk sync --dry-run                          # plan only, touch nothing`}
              </div>
              <p style={pStyle}>
                On each run, per file: if only your local file changed it is{" "}
                <strong>pushed</strong>; if only the cloud changed it is{" "}
                <strong>pulled</strong>; if both changed Desk does a 3-way merge
                against the last-synced version. A clean merge is pushed
                automatically. A conflicting merge is never lost and never blocks:
                your local edit is filed as a <strong>proposed revision</strong>{" "}
                (the same review queue as <a href="#editing" style={{ color: "var(--accent)", textDecoration: "none" }}>Proposing edits</a>) and
                your local file is set to the current cloud version, so the
                replica always converges. Writes are atomic, and the local file is
                never overwritten without going through the merge path.
              </p>
              {role === "admin" ? (
                <>
                  <p style={pStyle}>
                    <strong>Folders (admin).</strong> {code("link-dir")} maps a
                    cloud folder prefix to a local directory and adopts new docs
                    both ways — new cloud docs under the prefix are written
                    locally, and new local {code(".md")}/{code(".html")} files are
                    published under that prefix:
                  </p>
                  <div style={codeBlock}>
{`desk sync link-dir os ~/work/os             # adopt the folder both ways
desk sync`}
                  </div>
                  <p style={mutedP}>
                    Unpublishing a doc on the cloud side keeps your local file but
                    drops its mapping (with a notice) — sync never deletes local
                    data. {code("desk sync unlink <slug|prefix>")} stops syncing
                    something while keeping the local file.
                  </p>
                </>
              ) : (
                <p style={mutedP}>
                  As a member, your {code("desk sync")} pushes are always filed as{" "}
                  <strong>proposed revisions</strong> for an admin to review —
                  same as proposing an edit in the UI — and cloud changes still
                  pull down to your local copy normally. Publishing new docs and
                  linking folders are admin actions.
                </p>
              )}
              <p style={mutedP}>
                The manifest lives at {code("~/.config/desk/sync.json")} (override
                with {code("DESK_SYNC_MANIFEST")}); each machine is an independent
                replica that converges through the hub — no cross-machine
                coordination.
              </p>
            </Section>

            {/* ── Recipes ──────────────────────────────────────────────── */}
            <Section id="recipes" role={role}>
              <p style={pStyle}>
                Copy-pasteable patterns for the most common Desk workflows. Each
                recipe maps to tools and commands documented in the sections
                above.
              </p>

              {/* Recipe 1 — admin-only */}
              {role === "admin" && (
                <div style={{ ...cardStyle, marginBottom: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <strong style={{ fontSize: 13.5 }}>Share a local draft in one ask</strong>
                    <AdminTag />
                  </div>
                  <p style={{ ...pStyle, margin: "0 0 8px" }}>
                    Tell your agent:{" "}
                    <em>
                      &ldquo;Publish ~/path/to/pitch.md to Desk under{" "}
                      &lt;project&gt;/&lt;folder&gt; and give me a share link
                      labeled &lsquo;Partner review&rsquo;.&rdquo;
                    </em>
                  </p>
                  <p style={{ ...pStyle, margin: "0 0 8px" }}>
                    The agent calls {code("publish_doc")} (slug, path, content),
                    then {code("create_share")}, and replies with the{" "}
                    {code("share.<domain>/s/…")} URL. Anyone with the link can
                    read and comment — no account required.
                  </p>
                  <p style={{ ...pStyle, margin: "0 0 8px" }}>
                    <strong>Note:</strong> re-publishing the same slug updates
                    the live link in place. To freeze a specific version for a
                    reviewer, pass {code("pinned_version_id")} to{" "}
                    {code("create_share")} — the link will always show that
                    snapshot even after you publish a newer version.
                  </p>
                  <p style={{ ...mutedP, margin: 0 }}>
                    <strong>UI alternative:</strong> {code("git push")} the file
                    to a <InLink href="/spaces">space</InLink> → open the doc →
                    Sharing panel → New link.
                  </p>
                </div>
              )}

              {/* Recipe — share with a teammate inside Desk (admin-only) */}
              {role === "admin" && (
                <div style={{ ...cardStyle, marginBottom: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <strong style={{ fontSize: 13.5 }}>Share with a teammate inside Desk</strong>
                    <AdminTag />
                  </div>
                  <p style={{ ...pStyle, margin: "0 0 8px" }}>
                    When the person has a Desk account, you don&rsquo;t need a
                    link — add them to the doc&rsquo;s <strong>space</strong>:
                  </p>
                  <ol style={{ ...pStyle, paddingLeft: 20, margin: "0 0 8px" }}>
                    <li style={{ marginBottom: 4 }}>
                      Open the doc&rsquo;s space at{" "}
                      <InLink href="/spaces">/spaces/[slug]</InLink> and{" "}
                      <strong>add their user</strong> as a member. Keep the space{" "}
                      {code("private")} so only members see it.
                    </li>
                    <li style={{ marginBottom: 4 }}>
                      Or, to open it to everyone, set the space&rsquo;s visibility
                      to {code("unlisted")} or {code("public")}.
                    </li>
                  </ol>
                  <p style={{ ...mutedP, margin: 0 }}>
                    The teammate now sees the space&rsquo;s docs in{" "}
                    <InLink href="/spaces">/spaces</InLink>, search, and event feed
                    — no link, no public URL. Over MCP this is{" "}
                    {code("set_space_member")}.{" "}
                    <strong>Vs. a link:</strong> use a share link only for people{" "}
                    <em>without</em> a Desk account.
                  </p>
                </div>
              )}

              {/* Recipe 2 — all */}
              <div style={{ ...cardStyle, marginBottom: 16 }}>
                <strong style={{ fontSize: 13.5, display: "block", marginBottom: 8 }}>
                  Keep a file in sync across machines / people
                </strong>
                <p style={{ ...pStyle, margin: "0 0 8px" }}>
                  Link a slug to a local path once, then run {code("desk sync")} to
                  converge. Teammates&rsquo; pushes arrive as proposed revisions;
                  conflicts never block — they become revisions too.
                </p>
                <div style={codeBlock}>
{`desk sync link <slug> <localPath>
desk sync`}
                </div>
                <p style={{ ...mutedP, margin: 0 }}>
                  See the{" "}
                  <a href="#syncing" style={{ color: "var(--accent)", textDecoration: "none" }}>
                    Syncing local files
                  </a>{" "}
                  section for the full command set ({code("status")},{" "}
                  {code("--dry-run")}, {code("link-dir")}).
                </p>
              </div>

              {/* Recipe 3 — admin-only */}
              {role === "admin" && (
                <div style={{ ...cardStyle, marginBottom: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <strong style={{ fontSize: 13.5 }}>Trigger an agent when a card moves</strong>
                    <AdminTag />
                  </div>
                  <p style={{ ...pStyle, margin: "0 0 8px" }}>
                    Poll {code("list_events")} (or{" "}
                    {code("GET /api/events?since=<cursor>")}) filtering on{" "}
                    {code("card.moved")}, then fetch card context with{" "}
                    {code("get_card")}:
                  </p>
                  <div style={codeBlock}>
{`// MCP — page forward from last cursor
const { events, nextCursor } = await list_events({ since: cursor, kinds: ["card.moved"] });
for (const e of events) {
  const card = await get_card({ id: e.payload.cardId });
  // hand card to your agent …
}`}
                  </div>
                  <p style={{ ...mutedP, margin: 0 }}>
                    Advance {code("since")} to {code("nextCursor")} after each
                    poll. Every board mutation appends a {code("card.*")} /{" "}
                    {code("bucket.*")} event you can key on.
                  </p>
                </div>
              )}

              {/* Recipe 4 — admin-only */}
              {role === "admin" && (
                <div style={cardStyle}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                    <strong style={{ fontSize: 13.5 }}>Connect a teammate&rsquo;s agent</strong>
                    <AdminTag />
                  </div>
                  <ol style={{ ...pStyle, paddingLeft: 20, margin: "0 0 8px" }}>
                    <li style={{ marginBottom: 6 }}>
                      Create a Cloudflare Access <strong>service token</strong>{" "}
                      (Zero Trust → Access → Service Auth). Note the Client ID and
                      Client Secret.
                    </li>
                    <li style={{ marginBottom: 6 }}>
                      In{" "}
                      <InLink href="/admin">/admin → Users</InLink>, create or edit
                      the teammate&rsquo;s account and paste the{" "}
                      <strong>Client ID</strong> into the token field.
                    </li>
                    <li style={{ marginBottom: 6 }}>
                      Have the agent add the MCP server:
                      <div style={{ ...codeBlock, margin: "8px 0 0" }}>
{`claude mcp add desk --transport http https://<hub-host>/mcp \\
  --header "CF-Access-Client-Id: <id>" \\
  --header "CF-Access-Client-Secret: <secret>"`}
                      </div>
                    </li>
                  </ol>
                  <p style={{ ...mutedP, margin: 0 }}>
                    Full wiring details and the {code("whoami")} verification step
                    are in the{" "}
                    <a href="#mcp" style={{ color: "var(--accent)", textDecoration: "none" }}>
                      Connecting an agent (MCP)
                    </a>{" "}
                    section.
                  </p>
                </div>
              )}
            </Section>
          </div>
        </div>
      </div>

      {/* Two-column layout on wide viewports; single column on narrow.
          Plain CSS so the TOC can be sticky without JS-driven layout. */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
            .help-grid { display: block; }
            .help-toc { display: none; }
            @media (min-width: 880px) {
              .help-grid {
                display: grid;
                grid-template-columns: 200px minmax(0, 1fr);
                gap: 40px;
                align-items: start;
              }
              .help-toc { display: block; }
            }
          `,
        }}
      />
    </div>
  );
}
