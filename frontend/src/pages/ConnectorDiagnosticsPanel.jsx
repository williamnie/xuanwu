import { connectorsApi } from '../api/connectors.js';
import { useEffect, useState } from 'react';
import { Cable, RefreshCw, Settings2, ShieldX, TestTube2 } from 'lucide-react';
import { message } from '../store/toastStore';
import { PanelLoader } from '../components/TurtleLoader';
import { configureGuide } from './settingsProductModels.js';
import './ConnectorDiagnosticsPanel.css';

const CONNECTOR_STATUSES = ['configured', 'disabled', 'misconfigured', 'error'];

export default function ConnectorDiagnosticsPanel() {
  const [state, setState] = useState({ busy: '', configure: '', data: null, error: '', loading: true, notice: '', revoke: '' });

  useEffect(() => { loadConnectors(setState); }, []);

  const connectors = state.data?.connectors || [];
  return (
    <section className="glass-card connector-diagnostics">
      <PanelHeader loading={state.loading} onRefresh={() => loadConnectors(setState)} />
      {state.error && <div className="connector-diagnostics__error">{state.error}</div>}
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
    <div className="connector-diagnostics__header">
      <div>
        <h2 className="connector-diagnostics__heading">
          <Cable size={18} color="var(--primary)" /> Integration health
        </h2>
        <p className="connector-diagnostics__description">
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
    return <div className="connector-diagnostics__empty">{notice}</div>;
  }
  if (connectors.length === 0) {
    return <div className="connector-diagnostics__empty">暂无 connector manifest。</div>;
  }
  return (
    <div className="connector-diagnostics__body">
      <ConnectorSummary connectors={connectors} />
      <div className="connector-diagnostics__grid">
        {connectors.map(connector => <ConnectorCard connector={connector} key={`${connector.kind || 'connector'}:${connector.id}`}
          onConfigure={onConfigure} onRevoke={onRevoke} onTest={onTest} state={state} />)}
      </div>
    </div>
  );
}

function ConnectorSummary({ connectors }) {
  const counts = statusCounts(connectors);
  return (
    <div className="connector-diagnostics__summary">
      {CONNECTOR_STATUSES.map(status => (
        <span className={`connector-diagnostics__badge is-${status}`} key={status}>
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
    <div className="connector-diagnostics__card">
      <div className="connector-diagnostics__card-header">
        <div>
          <div className="connector-diagnostics__card-title">{connector.label || connector.id}</div>
          <div className="connector-diagnostics__card-subtitle">
            {connector.kind || 'connector'} · {connector.settings_mode || 'settings'}
          </div>
        </div>
        <span className={`connector-diagnostics__status is-${status}`}>{status}</span>
      </div>
      <ConnectorMeta label="Health" ok={status === 'configured'} value={healthText(connector)} />
      <ConnectorMeta label="Missing" ok={(connector.missing_required || []).length === 0} value={missingText(connector)} />
      <ConnectorMeta label="Manifest" ok value={connector.manifest_file || connector.summary?.callback_path || (connector.manifest?.contract_version ? `contract v${connector.manifest.contract_version}` : 'n/a')} />
      <ConnectorMeta label="最近同步" ok={Boolean(connector.health?.last_sync_at)} value={connector.health?.last_sync_at || '尚无同步记录'} />
      <ConnectorMeta label="权限" ok value={permissionText(connector)} />
      <ConnectorMeta label="退避" ok={!connector.health?.backoff?.blocked} value={backoffText(connector)} />
      <ConnectorEnv env={connector.env || []} />
      <SecretRefs refs={connector.secret_refs || []} />
      <div className="connector-diagnostics__actions">
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
    <div className="connector-diagnostics__guide">
      <strong>{guide.title}</strong>
      <span className="connector-diagnostics__muted">{guide.body}</span>
      {guide.refs && <code className="connector-diagnostics__refs">{guide.refs}</code>}
      {connector.id === 'feishu' && <button className="btn btn-secondary" onClick={() => document.getElementById('feishu-connection-settings')?.scrollIntoView({ behavior: 'smooth', block: 'start' })} type="button">前往飞书配置</button>}
      {connector.id === 'telegram' && <button className="btn btn-secondary" onClick={() => document.getElementById('telegram-connection-settings')?.scrollIntoView({ behavior: 'smooth', block: 'start' })} type="button">前往 Telegram 配置</button>}
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
    <div className="connector-diagnostics__meta">
      <span className="connector-diagnostics__meta-label">{label}</span>
      <span className="connector-diagnostics__meta-value">
        <span className={`status-dot connector-diagnostics__dot ${ok ? 'active' : 'idle'}`} />
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
