import { Loader2 } from 'lucide-react';

export function InterruptStatus({ interruptState, selectedId }) {
  if (!interruptState || interruptState.sessionId !== selectedId) return null;
  return (
    <div className={`session-interrupt-status ${interruptState.tone || 'info'}`} role="status">
      {interruptState.status === 'pending' && <Loader2 className="animate-spin" size={14} />}
      <span>{interruptState.text}</span>
    </div>
  );
}

export function QueueStatus({ queuedMessages, onCancel, onRetry }) {
  if (queuedMessages.length === 0) return null;
  return (
    <div className="session-message-queue-panel">
      {queuedMessages.length > 0 && (
        <ol className="session-message-queue-list" aria-label="排队消息">
          {queuedMessages.map((item, index) => (
            <li key={item.id} className={`session-message-queue-item ${item.status}`}>
              <div className="session-message-queue-main">
                <span className="session-message-queue-badge">{queueStatusLabel(item.status, index)}</span>
                <span className="session-message-queue-text">{queueMessagePreview(item)}</span>
                {item.error && <span className="session-message-queue-error">{item.error}</span>}
              </div>
              <div className="session-message-queue-actions">
                {item.status === 'failed' && (
                  <button type="button" onClick={() => onRetry?.(item.id)}>重试</button>
                )}
                <button type="button" onClick={() => onCancel?.(item.id)}>取消</button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function queueMessagePreview(item) {
  const text = String(item?.prompt || '').trim();
  if (text) return text;
  const refs = Array.isArray(item?.references) ? item.references : [];
  return refs.length ? `已附加 ${refs.length} 个 references` : '';
}

function queueStatusLabel(status, index) {
  if (status === 'sending') return '发送中';
  if (status === 'failed') return '待重试';
  return `排队 ${index + 1}`;
}
