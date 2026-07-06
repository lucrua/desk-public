import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import MermaidBlock from "./MermaidBlock";

export type MarkdownRegister = "partner" | "operator";

interface MarkdownProps {
  content: string;
  /** Visual register. `partner` = editorial serif; `operator` = dense sans. */
  register?: MarkdownRegister;
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
}: MarkdownProps) {
  const rehypePlugins = [
    [rehypeHighlight, { detect: true, ignoreMissing: true }],
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
