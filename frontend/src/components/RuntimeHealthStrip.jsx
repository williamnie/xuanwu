import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, ServerCog } from 'lucide-react';
import { api } from '../api/client';
import { buildRuntimeHealth } from './runtimeHealth';

export default function RuntimeHealthStrip({ backendOnline, navigateTo }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api.getSystemStatus()
      .then(data => {
        if (!alive) return;
        setStatus(data);
        setError('');
      })
      .catch(err => {
        if (!alive) return;
        setError(err.message || '读取 runtime status 失败');
      });
    return () => { alive = false; };
  }, []);

  const health = useMemo(
    () => buildRuntimeHealth({ status, error, backendOnline }),
    [status, error, backendOnline]
  );

  return (
    <section className="glass-card" style={stripStyle(health.ok)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
        {health.ok ? <ServerCog size={18} color="var(--success)" /> : <AlertTriangle size={18} color="var(--warning)" />}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '0.82rem', fontWeight: 700, color: health.ok ? 'var(--text-secondary)' : 'var(--warning)' }}>
            {health.title}
          </div>
          {!health.ok && <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: '2px', overflowWrap: 'anywhere' }}>{health.reason}</div>}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: 0 }}>
        {health.items.map(item => <HealthPill key={item.label} item={item} />)}
        {!health.ok && (
          <button className="btn btn-secondary" style={{ padding: '6px 10px', fontSize: '0.76rem' }} onClick={() => navigateTo('settings')}>
            去 Settings <ArrowRight size={12} />
          </button>
        )}
      </div>
    </section>
  );
}

function HealthPill({ item }) {
  return (
    <span style={pillStyle(item.ok)} title={`${item.label}: ${item.value}`}>
      <span className={`status-dot ${item.ok ? 'active' : 'idle'}`} style={{ width: '6px', height: '6px', flex: '0 0 auto' }}></span>
      <span>{item.label}</span>
      <strong style={{ color: 'var(--text-primary)' }}>{item.value}</strong>
    </span>
  );
}

function stripStyle(ok) {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: '24px',
    padding: '12px 16px',
    borderLeft: `4px solid ${ok ? 'var(--success)' : 'var(--warning)'}`,
    background: ok ? 'var(--success-bg)' : 'var(--warning-bg)',
  };
}

function pillStyle(ok) {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    whiteSpace: 'nowrap',
    border: '1px solid var(--border-color)',
    borderRadius: '999px',
    padding: '5px 9px',
    background: 'var(--bg-card)',
    color: ok ? 'var(--text-secondary)' : 'var(--warning)',
    fontSize: '0.74rem',
    lineHeight: 1.2,
  };
}
