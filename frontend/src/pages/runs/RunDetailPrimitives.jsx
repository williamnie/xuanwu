
import { Clock3, LoaderCircle, RefreshCw } from 'lucide-react';

import { RUN_EVENT_SCAN_LIMIT } from './runDetailModel.js';

export function Metric({ label, value, detail }) {
  return <div><span>{label}</span><strong title={value}>{value}</strong>{detail ? <small className="run-cost-completeness">{detail}</small> : null}</div>;
}

export function ResourceHeader({ eyebrow, icon: Icon, loading, onRefresh, title }) {
  return (
    <header className="run-resource-header">
      <div><span>{eyebrow}</span><h2><Icon size={14} /> {title}</h2></div>
      <button aria-label={`刷新${title}`} disabled={loading} onClick={onRefresh} type="button">
        <RefreshCw className={loading ? 'is-spinning' : ''} size={14} /> 刷新
      </button>
    </header>
  );
}

export function EventPageFooter({ events }) {
  return (
    <footer className="run-event-page-footer">
      {events.scanned >= RUN_EVENT_SCAN_LIMIT ? <span>仅显示近期记录</span> : null}
      {events.hasOlder ? (
        <button disabled={events.loadingMore} onClick={events.loadMore} type="button">
          {events.loadingMore ? <LoaderCircle className="is-spinning" size={13} /> : <Clock3 size={13} />}
          {events.loadingMore ? '加载中…' : '加载更早'}
        </button>
      ) : null}
    </footer>
  );
}

export function EmptyState({ icon: Icon, text }) {
  return <div className="run-detail-empty"><Icon size={16} /><span>{text}</span></div>;
}

export function ErrorState({ error, onRetry }) {
  return <div className="run-detail-error" role="alert"><span>{error}</span><button onClick={onRetry} type="button">重试</button></div>;
}

