import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Root, Element, Text } from "hast";
import { visit } from "unist-util-visit";
import MermaidBlock from "./MermaidBlock";
import { segmentRefs, type CatalogPattern } from "@/lib/catalog-refs";

export type MarkdownRegister = "partner" | "operator";

interface MarkdownProps {
  content: string;
  /** Visual register. `partner` = editorial serif; `operator` = dense sans. */
  register?: MarkdownRegister;
  /**
   * Active catalog { kind, idPattern } set. When provided (staff doc/card
   * readers), occurrences of any kind's id in the body auto-link to
   * /catalog/[kind]/[itemId]. Omit on share pages so refs stay plain text —
   * the share reader simply doesn't pass this, preserving the existing rule.
   */
  catalogPatterns?: CatalogPattern[];
}

/**
 * A rehype plugin that turns catalog-id occurrences in TEXT nodes into anchor
 * elements linking to /catalog/[kind]/[itemId]. Skips text inside <code>/<pre>
 * (ids in code fences/inline-code stay literal) and inside existing <a> (don't
 * nest links). Matching + segmentation is the pure segmentRefs() helper.
 */
const SKIP_PARENTS = new Set(["code", "pre", "a"]);

/**
 * Unified attacher: `rehypeCatalogRefs` is a plugin factory taking the active
 * pattern set as its option. unified calls it with the option and uses the
 * returned transformer — so it must be passed as `[rehypeCatalogRefs, patterns]`
 * (NOT pre-invoked).
 */
function rehypeCatalogRefs(patterns: CatalogPattern[]) {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (
        index == null ||
        parent == null ||
        parent.type !== "element" ||
        SKIP_PARENTS.has((parent as Element).tagName)
      ) {
        return;
      }
      const segs = segmentRefs(node.value, patterns);
      if (!segs.some((s) => s.type === "ref")) return;
      const replacement = segs.map((s): Text | Element =>
        s.type === "text"
          ? { type: "text", value: s.value }
          : {
              type: "element",
              tagName: "a",
              properties: { href: s.href, className: ["catalog-ref"] },
              children: [{ type: "text", value: s.itemId }],
            },
      );
      (parent.children as (Text | Element)[]).splice(index, 1, ...replacement);
      return index + replacement.length;
    });
  };
}

type CodeProps = ComponentPropsWithoutRef<"code"> & { node?: unknown };

/**
 * Extract the plain-text source of a fenced code block from react-markdown's
 * children. Highlighted blocks arrive as nested <span> elements, so we walk
 * recursively and concatenate string leaves.
 */
function nodeText(children: React.ReactNode): string {
  if (children == null) return "";
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(nodeText).join("");
  if (
    typeof children === "object" &&
    "props" in children &&
    children.props != null
  ) {
    return nodeText(
      (children.props as { children?: React.ReactNode }).children,
    );
  }
  return "";
}

/**
 * Shared, register-agnostic Markdown renderer.
 *
 * - GFM (tables, strikethrough, task lists) via remark-gfm.
 * - Syntax highlighting via rehype-highlight (hljs token classes; theme lives
 *   in globals.css).
 * - ```mermaid fences render a client-side <MermaidBlock> instead of a code
 *   block.
 *
 * Styling is scoped through the `.md-partner` / `.md-operator` wrapper class
 * (see globals.css). Component is fully synchronous (react-markdown v10).
 */
export default function Markdown({
  content,
  register = "partner",
  catalogPatterns,
}: MarkdownProps) {
  const rehypePlugins = [
    [rehypeHighlight, { detect: true, ignoreMissing: true }],
    ...(catalogPatterns && catalogPatterns.length > 0
      ? [[rehypeCatalogRefs, catalogPatterns]]
      : []),
  ] as Parameters<typeof ReactMarkdown>[0]["rehypePlugins"];
  return (
    <div className={register === "operator" ? "md-operator" : "md-partner"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={{
          code(props: CodeProps) {
            const { className, children, ...rest } = props;
            const match = /language-mermaid/.test(className ?? "");
            if (match) {
              return <MermaidBlock code={nodeText(children).replace(/\n$/, "")} />;
            }
            return (
              <code className={className} {...rest}>
                {children}
              </code>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
