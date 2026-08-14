import { AlertCircle, RefreshCw } from 'lucide-react';
import { holdReasonLabel, splitHoldText } from './projectHold';

function HoldText({ label, text }) {
  if (!text) return null;
  const { summary, full, collapsed } = splitHoldText(text);
  if (!collapsed) {
    return <div style={{ color: 'var(--text-secondary)', marginTop: '2px' }}>{label}{summary}</div>;
  }
  return (
    <details style={{ color: 'var(--text-secondary)', marginTop: '2px' }}>
      <summary style={{ cursor: 'pointer' }}>{label}{summary}</summary>
      <pre style={{
        margin: '6px 0 0 0',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        fontFamily: 'var(--font-mono)',
      }}>
        {full}
      </pre>
    </details>
  );
}

export default function ProjectHoldNotice({ hold, onResume, resuming }) {
  if (!hold) return null;
  return (
    <div style={{
      border: '1px solid rgba(245, 158, 11, 0.32)',
      background: 'var(--warning-bg)',
      color: 'var(--warning)',
      borderRadius: 'var(--radius-md)',
      padding: '10px',
      fontSize: '0.72rem',
      lineHeight: 1.45,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'flex-start' }}>
        <strong style={{ display: 'inline-flex', gap: '5px', alignItems: 'center' }}>
          <AlertCircle size={13} /> Queue hold · {holdReasonLabel(hold.reason)}
        </strong>
        <button className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '0.68rem', flexShrink: 0 }} onClick={onResume} disabled={resuming}>
          <RefreshCw size={11} className={resuming ? 'animate-spin' : ''} />
          {resuming ? '自检中' : '恢复'}
        </button>
      </div>
      <HoldText text={hold.message} />
      {hold.hold_since && <div style={{ color: 'var(--text-muted)', marginTop: '3px' }}>Hold 于：{hold.hold_since}</div>}
      {hold.next_check_at && <div style={{ color: 'var(--text-muted)', marginTop: '2px' }}>下次自检：{hold.next_check_at}</div>}
      <HoldText label="最近自检：" text={hold.last_check_error} />
      <div style={{ color: 'var(--text-muted)', marginTop: '6px' }}>恢复会先执行只读健康检查，通过后才清除 hold。</div>
    </div>
  );
}
