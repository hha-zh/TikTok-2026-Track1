import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantMarkdown } from "./AssistantMarkdown";

describe("AssistantMarkdown", () => {
  it("renders emphasis and lists as semantic markup", () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown>{"**Approval needed**\n\n- THAI\n- Batik Air"}</AssistantMarkdown>,
    );
    expect(html).toContain("<strong>Approval needed</strong>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>THAI</li>");
  });

  it("drops raw HTML instead of executing or rendering it", () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown>{'Safe text <img src="x" onerror="alert(1)">'}</AssistantMarkdown>,
    );
    expect(html).toContain("Safe text");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
  });
});
