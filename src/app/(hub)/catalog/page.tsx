import { headers } from "next/headers";
import { getPrincipal } from "@/lib/auth";
import { scopeForPrincipal } from "@/lib/docs";
import {
  catalogSpaces,
  directoriesInSpace,
  catalogDocs,
  readCollectionConfig,
} from "@/lib/catalog/source";
import { projectCatalog } from "@/lib/catalog/projection";
import CatalogProjectionClient, { type SchemaDTO } from "./CatalogProjectionClient";

export const dynamic = "force-dynamic";

/**
 * The catalog surface — Gen-2 reframe (D6): a PROJECTION of a space directory's
 * frontmatter, not a Desk-authored registry.
 *
 * The reader picks a space + (optional) directory via ?space=&dir=. The server
 * resolves the docs under that prefix (scope-filtered so a member never sees a
 * private space's docs), reads their parsed frontmatter, and — when a
 * `.desk.collection.yml` exists in that directory (read from the space's bare git
 * repo at the current commit) — parses it into a schema (fields/enums/views) and
 * validates each doc, surfacing drift. With no schema it falls back to AUTO mode
 * (the union of frontmatter fields). View/group/sort/filter are display-only
 * client state; the catalog is READ/RENDER-ONLY (no file or DB writes).
 */
export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ space?: string; dir?: string }>;
}) {
  const [principal, sp] = await Promise.all([
    getPrincipal(await headers()),
    searchParams,
  ]);
  const scope = await scopeForPrincipal(principal);

  const spaces = await catalogSpaces(scope);
  // Owner-namespace S5: the catalog `?space=` param is owner-qualified
  // (`<owner>/<slug>`) — a slug alone is no longer unique. Default to the chosen
  // one, else the first visible space. Resolution flows through the space id.
  const qualify = (o: { owner: string; slug: string }) => `${o.owner}/${o.slug}`;
  const picked =
    (sp.space ? spaces.find((s) => qualify(s) === sp.space) : undefined) ?? spaces[0] ?? null;
  const spaceParam = picked ? qualify(picked) : null;
  const dir = sp.dir ?? "";

  let dirs: Array<{ path: string; count: number }> = [];
  let projection = projectCatalog([], null);
  let schema: SchemaDTO = null;

  if (picked) {
    dirs = (await directoriesInSpace(picked.id, scope)) ?? [];
    // Clamp the requested dir to one that exists (else root).
    const effectiveDir = dirs.some((d) => d.path === dir) ? dir : "";
    const docs = (await catalogDocs(picked.id, effectiveDir, scope)) ?? [];
    const cfg = await readCollectionConfig(picked.id, effectiveDir);
    projection = projectCatalog(docs, cfg?.config ?? null);
    if (cfg && cfg.config.fields.length > 0) {
      schema = {
        fields: cfg.config.fields,
        views: cfg.config.views,
        defaultView: cfg.config.defaultView,
        notes: cfg.config.notes,
        rawPath: cfg.rawPath,
      };
    }
  }

  return (
    <CatalogProjectionClient
      spaces={spaces}
      dirs={dirs}
      space={spaceParam}
      dir={dirs.some((d) => d.path === dir) ? dir : ""}
      projection={projection}
      schema={schema}
    />
  );
}
