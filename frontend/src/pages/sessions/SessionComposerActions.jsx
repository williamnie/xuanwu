import { Loader2, Square, ArrowUp } from 'lucide-react';

export function ComposerActions({
  sending,
  running,
  interrupting,
  selectedId,
  canSend,
  hasQueuedMessages,
  followMode,
  onFollowModeChange,
  onStop,
}) {
  const modeSwitch = running && onFollowModeChange && canSend ? (
    <ComposerModeSwitch value={followMode} onChange={onFollowModeChange} disabled={sending || interrupting} />
  ) : null;
  if (running) {
    return (
      <>
        {modeSwitch}
        <button type="button" className="session-composer-circle stop" onClick={onStop} disabled={!selectedId || interrupting} title={interrupting ? '正在中断...' : '停止'}>
          {interrupting ? <Loader2 className="animate-spin" size={14} /> : <Square size={14} fill="currentColor" />}
        </button>
      </>
    );
  }
  return (
    <button className="session-composer-circle" disabled={!selectedId || !canSend || sending || interrupting} title={hasQueuedMessages ? '追加到队列' : '发送'}>
      {sending ? <Loader2 className="animate-spin" size={14} /> : <ArrowUp size={16} strokeWidth={2} />}
    </button>
  );
}

export function ComposerModeSwitch({ value, onChange, disabled }) {
  return (
    <div className="session-composer-mode-switch" role="group" aria-label="运行中发送行为">
      <button
        type="button"
        className={!value ? 'active' : ''}
        disabled={disabled}
        onClick={() => onChange?.(false)}
      >
        排队
      </button>
      <button
        type="button"
        className={value ? 'active' : ''}
        disabled={disabled}
        onClick={() => onChange?.(true)}
      >
        引导
      </button>
    </div>
  );
}
