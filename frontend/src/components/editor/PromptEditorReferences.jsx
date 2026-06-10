import { useMemo } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';

export default function PromptEditorReferences({ details = [], onRemove }) {
  const items = useMemo(() => Array.isArray(details) ? details : [], [details]);
  if (items.length === 0) return null;
  return (
    <div className="prompt-reference-area">
      <div className="prompt-reference-chips" aria-label="Attached references">
        {items.map((item) => (
          <span
            key={item.key}
            className={`prompt-reference-chip ${item.status}`}
            title={referenceLabel(item)}
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
