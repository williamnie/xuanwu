import { useEffect, useState } from 'react';
import { Cable, RefreshCw } from 'lucide-react';
import { api } from '../api/client';

const CONNECTOR_STATUSES = ['configured', 'disabled', 'misconfigured', 'error'];

export default function ConnectorDiagnosticsPanel() {
  const [state, setState] = useState({ data: null, error: '', loading: true, notice: '' });

  useEffect(() => { loadConnectors(setState); }, []);

  const connectors = state.data?.connectors || [];
  return (
    <section className="glass-card" style={{ display: 'grid', gap: '16px' }}>
      <PanelHeader loading={state.loading} onRefresh={() => loadConnectors(setState)} />
      {state.error && <div style={{ color: 'var(--error)', fontSize: '0.86rem' }}>{state.error}</div>}
      {!state.error && <ConnectorBody connectors={connectors} loading={state.loading} notice={state.notice} />}
    </section>
  );
}

function loadConnectors(setState) {
  setState(previous => ({ ...previous, loading: true }));
  api.getPiConnectors()
    .then(data => setState({ data, error: '', loading: false, notice: '' }))
    .catch(error => setState(previous => ({
      ...previous,
      data: error.status === 404 ? { connectors: [] } : previous.data,
      error: error.status === 404 ? '' : error.message || '读取 connector 诊断失败',
      notice: error.status === 404 ? 'Connector API coming soon；当前 runtime 尚未启用 connector diagnostics。' : '',
      loading: false
    })));
}

function PanelHeader({ loading, onRefresh }) {
  return (
    <div style={{ alignItems: 'center', display: 'flex', gap: '16px', justifyContent: 'space-between' }}>
      <div>
        <h2 style={{ alignItems: 'center', display: 'flex', fontSize: '1.1rem', fontWeight: 700, gap: '8px' }}>
          <Cable size={18} color="var(--primary)" /> Connector Diagnostics
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '4px' }}>
          只读检查 CLI connector 的配置、health command 最近结果与缺失项；不返回 secret 明文。
        </p>
      </div>
      <button className="btn btn-secondary" disabled={loading} onClick={onRefresh} type="button">
        <RefreshCw size={15} className={loading ? 'spin-animation' : ''} />
        刷新
      </button>
    </div>
  );
}

function ConnectorBody({ connectors, loading, notice }) {
  if (loading && connectors.length === 0) {
    return <div style={{ color: 'var(--text-muted)', fontSize: '0.86rem' }}>正在读取 connector 诊断...</div>;
  }
  if (notice) {
    return <div style={{ color: 'var(--text-muted)', fontSize: '0.86rem' }}>{notice}</div>;
  }
  if (connectors.length === 0) {
    return <div style={{ color: 'var(--text-muted)', fontSize: '0.86rem' }}>暂无 connector manifest。</div>;
  }
  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      <ConnectorSummary connectors={connectors} />
      <div style={{ display: 'grid', gap: '12px', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        {connectors.map(connector => <ConnectorCard connector={connector} key={`${connector.kind || 'connector'}:${connector.id}`} />)}
      </div>
    </div>
  );
}

function ConnectorSummary({ connectors }) {
  const counts = statusCounts(connectors);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
      {CONNECTOR_STATUSES.map(status => (
        <span key={status} style={summaryBadgeStyle(status)}>
          {status}: {counts[status] || 0}
        </span>
      ))}
    </div>
  );
}

function ConnectorCard({ connector }) {
  const status = connectorStatus(connector);
  return (
    <div style={connectorCardStyle()}>
      <div style={{ alignItems: 'center', display: 'flex', gap: '10px', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontWeight: 800 }}>{connector.label || connector.id}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.74rem', marginTop: '2px' }}>
            {connector.kind || 'connector'} · {connector.settings_mode || 'settings'}
          </div>
        </div>
        <span style={{ color: statusColor(status), fontSize: '0.78rem', fontWeight: 800 }}>{status}</span>
      </div>
      <ConnectorMeta label="Health" ok={status === 'configured'} value={healthText(connector)} />
      <ConnectorMeta label="Missing" ok={(connector.missing_required || []).length === 0} value={missingText(connector)} />
      <ConnectorMeta label="Manifest" ok value={connector.manifest_file || connector.summary?.callback_path || 'n/a'} />
      <ConnectorEnv env={connector.env || []} />
    </div>
  );
}

function ConnectorMeta({ label, ok, value }) {
  return (
    <div style={{ display: 'grid', gap: '4px' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{label}</span>
      <span style={{ alignItems: 'center', display: 'flex', fontSize: '0.84rem', gap: '8px', wordBreak: 'break-word' }}>
        <span className={`status-dot ${ok ? 'active' : 'idle'}`} style={{ flex: '0 0 auto', height: '7px', width: '7px' }} />
        {value}
      </span>
    </div>
  );
}

function ConnectorEnv({ env }) {
  if (!env.length) return null;
  const label = env.map(item => `${item.name}${item.configured ? '' : ' missing'}`).join(' · ');
  return <ConnectorMeta label="Env" ok={env.every(item => item.configured || !item.required)} value={label} />;
}

function statusCounts(connectors) {
  return connectors.reduce((counts, connector) => {
    const status = connectorStatus(connector);
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
}

function connectorStatus(connector) {
  return connector.status || connector.summary?.state || 'unknown';
}

function healthText(connector) {
  const health = connector.health || {};
  if (health.checked === false) return health.error?.message || 'skipped';
  if (health.status) return health.error?.message || health.status;
  return connector.summary?.error || 'static check';
}

function missingText(connector) {
  const missing = connector.missing_required || [];
  return missing.length > 0 ? missing.join(', ') : '无';
}

function statusColor(status) {
  if (status === 'configured') return 'var(--success)';
  if (status === 'error' || status === 'misconfigured') return 'var(--warning)';
  return 'var(--text-muted)';
}

function connectorCardStyle() {
  return {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-light)',
    borderRadius: '14px',
    display: 'grid',
    gap: '10px',
    padding: '14px'
  };
}

function summaryBadgeStyle(status) {
  return {
    background: status === 'configured' ? 'var(--success-glow)' : 'var(--bg-secondary)',
    border: '1px solid var(--border-light)',
    borderRadius: '999px',
    color: statusColor(status),
    fontSize: '0.76rem',
    fontWeight: 800,
    padding: '6px 10px'
  };
}
