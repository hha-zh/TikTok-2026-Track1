import type { Message } from "./types";
import { AssistantMarkdown } from "./AssistantMarkdown";

export const GOVERNED_PROGRESS_LABEL = "Governed recovery is running…";

function formatPersistedTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function ConversationMessage({
  message,
  agentDisplayName,
}: {
  message: Message;
  agentDisplayName: string;
}) {
  return (
    <article className={`message message-${message.role}`}>
      <div className="message-meta">
        <strong>{message.role === "user" ? "You" : agentDisplayName}</strong>
        <span>{formatPersistedTime(message.createdAt)}</span>
      </div>
      <div className="message-body">
        {message.role === "assistant"
          ? <AssistantMarkdown>{message.content}</AssistantMarkdown>
          : message.content}
      </div>
    </article>
  );
}
