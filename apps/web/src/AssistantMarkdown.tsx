import ReactMarkdown from "react-markdown";

export function AssistantMarkdown({ children }: { children: string }) {
  return (
    <div className="assistant-markdown">
      <ReactMarkdown skipHtml>{children}</ReactMarkdown>
    </div>
  );
}
