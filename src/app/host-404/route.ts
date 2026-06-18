// Route handler for the share-host guard 404.
//
// The middleware rewrites blocked share-host paths (anything that isn't
// /s/*, /robots.txt, or /_next/*) to this route, which returns a real
// HTTP 404 response with a minimal styled HTML page.
//
// Using a route handler (not a page component) is the only way to return a
// genuine 404 status from a middleware rewrite in Next.js App Router — a
// page component is always served with 200 regardless of the rewrite target.
//
// Copy (heading) is imported from constants.ts so it can never drift from the
// /s/[token]/not-found.tsx page that uses the same constant.
import { NOTHING_HERE_HEADING, NOTHING_HERE_HOST_BODY } from "@/lib/constants";

// Inline style values match the design tokens from globals.css (light theme
// defaults — this page is intentionally minimal and has no theme-switching).
const BG = "#f7f5f0";
const INK = "#211e19";
const MUTED = "#6e675c";
const FAINT = "#9b937f";

function buildHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/>
<title>404 — Desk</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:${BG};color:${INK};font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Helvetica,Arial,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.wrap{max-width:380px;text-align:center}
.code{font-family:"SFMono-Regular",Menlo,monospace;font-size:12px;letter-spacing:.14em;color:${FAINT};margin-bottom:18px}
h1{font-size:27px;font-weight:500;letter-spacing:-.01em;margin:0 0 12px;line-height:1.25}
p{font-size:17px;line-height:1.6;color:${MUTED}}
</style>
</head>
<body>
<div class="wrap">
<div class="code">404</div>
<h1>${NOTHING_HERE_HEADING}</h1>
<p>${NOTHING_HERE_HOST_BODY}</p>
</div>
</body>
</html>`;
}

export function GET() {
  return new Response(buildHtml(), {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
