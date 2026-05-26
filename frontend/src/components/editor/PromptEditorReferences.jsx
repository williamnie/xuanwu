import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';

export default function PromptEditorReferences({ details = [], onRemove }) {
  const items = useMemo(() => Array.isArray(details) ? details : [], [details]);
  const [selectedKey, setSelectedKey] = useState('');
  const activeKey = selectedKey || items[0]?.key || '';
  const active = useMemo(() => items.find((item) => item.key === activeKey) || items[0], [items, activeKey]);
  if (items.length === 0) return null;
  return (
    <div className="prompt-reference-area">
      <div className="prompt-reference-chips" aria-label="Attached references">
        {items.map((item) => (
          <span
            key={item.key}
            role="button"
            tabIndex={0}
            className={`prompt-reference-chip ${item.status} ${item.key === active?.key ? 'active' : ''}`}
            onClick={() => setSelectedKey(item.key)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              setSelectedKey(item.key);
            }}
            title="查看 reference 详情"
          >
            <ReferenceIcon status={item.status} />
            <span className="prompt-reference-type">{item.type}</span>
            <span className="prompt-reference-label">{referenceLabel(item)}</span>
            <button
              type="button"
              className="prompt-reference-remove"
              aria-label={`移除 ${referenceLabel(item)}`}
              onClick={(event) => {
                event.stopPropagation();
                onRemove?.(item.key);
              }}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      {active && <ContextInspector active={active} items={items} />}
    </div>
  );
}

function ContextInspector({ active, items }) {
  const warningCount = items.filter((item) => item.status === 'warning').length;
  const errorCount = items.filter((item) => item.status === 'error').length;
  return (
    <div className={`prompt-context-inspector ${active.status}`}>
      <div className="prompt-context-inspector-head">
        <span>Context inspector</span>
        <span>{items.length} attached · {statusText(errorCount, warningCount)}</span>
      </div>
      <div className="prompt-context-inspector-body">
        <strong>{referenceLabel(active)}</strong>
        <span>{active.summary || '等待上下文摘要'}</span>
        {active.message && <em>{active.message}</em>}
      </div>
    </div>
  );
}

function ReferenceIcon({ status }) {
  if (status === 'error') return <XCircle size={13} />;
  if (status === 'warning') return <AlertTriangle size={13} />;
  if (status === 'ready') return <CheckCircle2 size={13} />;
  return <Info size={13} />;
}

function referenceLabel(item) {
  return item.label || item.id || item.path || item.name || item.type;
}

function statusText(errors, warnings) {
  if (errors > 0) return `${errors} error`;
  if (warnings > 0) return `${warnings} warning`;
  return 'ready';
}
