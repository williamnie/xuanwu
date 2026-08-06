import { connectorsApi } from '../api/connectors.js';
import { useEffect, useState } from 'react';
import { Cable, RefreshCw, Settings2, ShieldX, TestTube2 } from 'lucide-react';
import { message } from '../store/toastStore';
import { PanelLoader } from '../components/TurtleLoader';
import { configureGuide } from './settingsProductModels.js';

const CONNECTOR_STATUSES = ['configured', 'disabled', 'misconfigured', 'error'];

export default function ConnectorDiagnosticsPanel() {
  const [state, setState] = useState({ busy: '', configure: '', data: null, error: '', loading: true, notice: '', revoke: '' });

  useEffect(() => { loadConnectors(setState); }, []);

  const connectors = state.data?.connectors || [];
  return (
    <section className="glass-card" style={{ display: 'grid', gap: '16px' }}>
      <PanelHeader loading={state.loading} onRefresh={() => loadConnectors(setState)} />
      {state.error && <div style={{ color: 'var(--error)', fontSize: '0.86rem' }}>{state.error}</div>}
      {!state.error && <ConnectorBody connectors={connectors} loading={state.loading} notice={state.notice}
        onConfigure={(connector) => setState(previous => ({ ...previous, configure: previous.configure === connector.id ? '' : connector.id }))}
        onRevoke={(connector, ref) => revokeConnectorSecret(connector, ref, state, setState)}
        onTest={(connector) => testConnector(connector, state, setState)} state={state} />}
    </section>
  );
}

function loadConnectors(setState) {
  setState(previous => ({ ...previous, loading: true }));
  connectorsApi.getPiConnectors()
    .then(data => setState(previous => ({ ...previous, data, error: '', loading: false, notice: '' })))
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
          <Cable size={18} color="var(--primary)" /> Integration health
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '4px' }}>
          查看 Feishu、Git、Tracker、Webhook 与本地 connector 的配置健康；测试和撤销均使用现有受审计 API。
        </p>
      </div>
      <button className="btn btn-secondary" disabled={loading} onClick={onRefresh} type="button">
        <RefreshCw size={15} className={loading ? 'spin-animation' : ''} />
        刷新
      </button>
    </div>
  );
}

function ConnectorBody({ connectors, loading, notice, onConfigure, onRevoke, onTest, state }) {
  if (loading && connectors.length === 0) {
    return <PanelLoader label="正在检查 Connector…" />;
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
        {connectors.map(connector => <ConnectorCard connector={connector} key={`${connector.kind || 'connector'}:${connector.id}`}
          onConfigure={onConfigure} onRevoke={onRevoke} onTest={onTest} state={state} />)}
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

function ConnectorCard({ connector, onConfigure, onRevoke, onTest, state }) {
  const status = connectorStatus(connector);
  const revocable = (connector.secret_refs || []).find(item => item.revocable);
  const revokeKey = revocable ? `${connector.id}::${revocable.ref}` : '';
  const testing = state.busy === `test:${connector.id}`;
  const revoking = state.busy === `revoke:${connector.id}`;
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
      <ConnectorMeta label="Manifest" ok value={connector.manifest_file || connector.summary?.callback_path || (connector.manifest?.contract_version ? `contract v${connector.manifest.contract_version}` : 'n/a')} />
      <ConnectorMeta label="最近同步" ok={Boolean(connector.health?.last_sync_at)} value={connector.health?.last_sync_at || '尚无同步记录'} />
      <ConnectorMeta label="权限" ok value={permissionText(connector)} />
      <ConnectorMeta label="退避" ok={!connector.health?.backoff?.blocked} value={backoffText(connector)} />
      <ConnectorEnv env={connector.env || []} />
      <SecretRefs refs={connector.secret_refs || []} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        <button className="btn btn-secondary" onClick={() => onConfigure(connector)} type="button"><Settings2 size={14} />配置</button>
        {connector.test_connection?.supported && <button className="btn btn-secondary" disabled={testing || connector.health?.backoff?.blocked}
          onClick={() => onTest(connector)} type="button"><TestTube2 size={14} />{testing ? '测试中…' : '测试连接'}</button>}
        {revocable && state.revoke !== revokeKey && <button className="btn btn-secondary" disabled={revoking}
          onClick={() => onRevoke(connector, revocable)} type="button"><ShieldX size={14} />撤销凭据</button>}
        {revocable && state.revoke === revokeKey && <>
          <button className="btn btn-danger" disabled={revoking} onClick={() => onRevoke(connector, revocable)} type="button">
            {revoking ? '撤销中…' : '确认撤销'}</button>
          <button className="btn btn-secondary" disabled={revoking} onClick={() => onRevoke(null, null)} type="button">取消</button>
        </>}
      </div>
      {state.configure === connector.id && <ConnectorConfigureGuide connector={connector} />}
    </div>
  );
}

function ConnectorConfigureGuide({ connector }) {
  const guide = configureGuide(connector);
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-light)', borderRadius: '12px', display: 'grid', fontSize: '0.78rem', gap: '7px', lineHeight: 1.5, padding: '10px' }}>
      <strong>{guide.title}</strong>
      <span style={{ color: 'var(--text-muted)' }}>{guide.body}</span>
      {guide.refs && <code style={{ overflowWrap: 'anywhere' }}>{guide.refs}</code>}
      {connector.id === 'feishu' && <button className="btn btn-secondary" onClick={() => document.getElementById('feishu-connection-settings')?.scrollIntoView({ behavior: 'smooth', block: 'start' })} type="button">前往飞书配置</button>}
    </div>
  );
}

function SecretRefs({ refs }) {
  if (!refs.length) return null;
  const value = refs.map(item => `${item.name}: ${item.status}${item.version ? ` v${item.version}` : ''}`).join(' · ');
  return <ConnectorMeta label="Secret refs" ok={refs.every(item => !item.required || item.status === 'active' || item.status === 'legacy')} value={value} />;
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
  if (health.state) return health.last_error?.message || health.state;
  if (health.checked === false) return health.error?.message || 'skipped';
  if (health.status) return health.error?.message || health.status;
  return connector.summary?.error || 'static check';
}

function permissionText(connector) {
  const permissions = connector.permissions || [];
  if (!permissions.length) return '未声明';
  return permissions.map(item => `${item.capability_id} (${item.authorization})`).join(' · ');
}

function backoffText(connector) {
  const backoff = connector.health?.backoff;
  if (!backoff?.blocked) return '未退避';
  return `第 ${backoff.attempt} 次失败，${backoff.retry_at} 后重试`;
}

async function testConnector(connector, state, setState) {
  setState({ ...state, busy: `test:${connector.id}` });
  try {
    const response = await connectorsApi.testPiConnector(connector.id);
    message[response.result?.ok ? 'success' : 'error'](response.result?.ok ? '连接测试通过' : response.result?.error?.message || '连接测试失败');
    await loadConnectors(setState);
    setState(previous => ({ ...previous, busy: '' }));
  } catch (error) {
    message.error(error.message || '连接测试失败');
    setState(previous => ({ ...previous, busy: '' }));
  }
}

async function revokeConnectorSecret(connector, ref, state, setState) {
  if (!connector || !ref) {
    setState(previous => ({ ...previous, revoke: '' }));
    return;
  }
  const key = `${connector.id}::${ref.ref}`;
  if (state.revoke !== key) {
    setState(previous => ({ ...previous, revoke: key }));
    return;
  }
  setState(previous => ({ ...previous, busy: `revoke:${connector.id}` }));
  try {
    await connectorsApi.revokePiConnectorSecret(connector.id, ref.ref);
    message.success('凭据已撤销并从当前运行态失效');
    await loadConnectors(setState);
    setState(previous => ({ ...previous, busy: '', revoke: '' }));
  } catch (error) {
    message.error(error.message || '撤销凭据失败');
    setState(previous => ({ ...previous, busy: '' }));
  }
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
