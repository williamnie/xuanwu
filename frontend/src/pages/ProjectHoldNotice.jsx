import { AlertCircle, RefreshCw } from 'lucide-react';
import { holdReasonLabel, splitHoldText } from './projectHold';
import './ProjectHoldNotice.css';

function HoldText({ label, text }) {
  if (!text) return null;
  const { summary, full, collapsed } = splitHoldText(text);
  if (!collapsed) {
    return <div className="project-hold-notice__text">{label}{summary}</div>;
  }
  return (
    <details className="project-hold-notice__text">
      <summary className="project-hold-notice__summary">{label}{summary}</summary>
      <pre className="project-hold-notice__full-text">
        {full}
      </pre>
    </details>
  );
}

export default function ProjectHoldNotice({ hold, onResume, resuming }) {
  if (!hold) return null;
  return (
    <div className="project-hold-notice">
      <div className="project-hold-notice__header">
        <strong className="project-hold-notice__title">
          <AlertCircle size={13} /> Queue hold · {holdReasonLabel(hold.reason)}
        </strong>
        <button className="btn btn-secondary project-hold-notice__resume" onClick={onResume} disabled={resuming}>
          <RefreshCw size={11} className={resuming ? 'animate-spin' : ''} />
          {resuming ? '自检中' : '恢复'}
        </button>
      </div>
      <HoldText text={hold.message} />
      {hold.hold_since && <div className="project-hold-notice__meta project-hold-notice__meta--spaced">Hold 于：{hold.hold_since}</div>}
      {hold.next_check_at && <div className="project-hold-notice__meta">下次自检：{hold.next_check_at}</div>}
      <HoldText label="最近自检：" text={hold.last_check_error} />
      <div className="project-hold-notice__help">恢复会先执行只读健康检查，通过后才清除 hold。</div>
    </div>
  );
}
