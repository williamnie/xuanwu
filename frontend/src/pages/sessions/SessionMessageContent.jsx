import { textFromUserContent } from './sourceIssue';
import MarkdownPreview from '../../components/editor/MarkdownPreview';

export function UserMessageBubble({ item, timestamp }) {
  const text = textFromUserContent(item.content);
  return (
    <div className="chat-bubble-container user session-user-message">
      <div className="chat-bubble-content">
        <MessageHeader avatar="IN" role="任务输入" timestamp={timestamp} />
        <div className="chat-bubble-body">
          <MarkdownText text={text} />
        </div>
      </div>
    </div>
  );
}

export function AgentMessageBubble({ item }) {
  const text = item.text || '';
  return (
    <div className="session-agent-copy animate-fade-in">
      <MarkdownText text={text} />
    </div>
  );
}

export function MessageHeader({ avatar, role, timestamp }) {
  return (
    <div className="session-message-head">
      <span className="session-message-avatar">{avatar}</span>
      <span className="session-message-role">{role}</span>
      {timestamp ? <time className="session-message-time">{timestamp}</time> : null}
    </div>
  );
}

export function MarkdownText({ text }) {
  return <MarkdownPreview text={text || ''} className="session-markdown" />;
}
