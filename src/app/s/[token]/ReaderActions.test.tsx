// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ReaderActions from "./ReaderActions";

describe("ReaderActions (share reader)", () => {
  it("renders a Copy button and a Download link to the raw route", () => {
    const html = renderToStaticMarkup(
      <ReaderActions token="abc123" source="# hi" />,
    );
    expect(html).toContain("Copy");
    expect(html).toContain("Download");
    // Download points at the public capability route for this token.
    expect(html).toContain('href="/api/s/abc123/raw"');
  });
});
