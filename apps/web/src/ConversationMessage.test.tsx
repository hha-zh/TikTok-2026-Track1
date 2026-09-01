import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message } from "./types";
import { ConversationMessage, GOVERNED_PROGRESS_LABEL } from "./ConversationMessage";

const assistantMessage: Message = {
  id: "message-1",
  agentId: "persistent-agent-1",
  runId: "governed-run-1",
  role: "assistant",
  content: "### Recovery plan ready\n\n- **Approval required:** Yes",
  createdAt: "2026-09-01T00:17:00.000Z",
};

describe("ConversationMessage", () => {
  it.each(["Trip Guardian", "My Recovery Agent"])(
    "renders the persistent Agent name %s with the persisted timestamp",
    (agentDisplayName) => {
      const html = renderToStaticMarkup(
        <ConversationMessage message={assistantMessage} agentDisplayName={agentDisplayName} />,
      );
      const expectedTime = new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(assistantMessage.createdAt));

      expect(html).toContain(`<strong>${agentDisplayName}</strong>`);
      expect(html).toContain(`<span>${expectedTime}</span>`);
      expect(html).not.toContain("Travel Recovery Assistant");
      expect(html).not.toContain("Live Travel root");
      expect(html).not.toContain("Governed child");
      expect(html).toContain("<h3>Recovery plan ready</h3>");
      expect(html).toContain("<strong>Approval required:</strong> Yes");
    },
  );

  it("reproduces the same header when persisted history is rendered again", () => {
    const renderHistory = () => renderToStaticMarkup(
      <ConversationMessage message={assistantMessage} agentDisplayName="Trip Guardian" />,
    );
    expect(renderHistory()).toBe(renderHistory());
  });

  it("preserves the governed progress label", () => {
    expect(GOVERNED_PROGRESS_LABEL).toBe("Governed recovery is running…");
  });
});
