import { redirect } from "next/navigation";

/**
 * The flat `/docs` list is retired (Gen-2 consolidation, D1). Spaces is the home:
 * docs are browsed inside a space (`/spaces/[slug]`), and the per-doc viewer at
 * `/docs/[slug]` is reached from there (deep links still resolve). Any visit to
 * the old flat list lands on Spaces.
 */
export default function DocsIndexPage(): never {
  redirect("/spaces");
}
