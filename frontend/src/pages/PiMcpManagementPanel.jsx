import { connectorsApi } from '../api/connectors.js';
import { useEffect, useMemo, useState } from 'react';
import { PlugZap, RefreshCw, ShieldCheck } from 'lucide-react';
import { message } from '../store/toastStore';

const emptyForm = { args: '', command: '', envKeys: '', name: '' };
const redactedText = '[redacted]';

export default function PiMcpManagementPanel() {
  const state = useMcpManagementState();
  const detected = state.servers.filter((server) => server.source !== 'manual');
  const manual = state.servers.filter((server) => server.source === 'manual');
  return (
    <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <PanelHeader loading={state.loading} onRefresh={state.loadAll} onScan={state.scan} scanning={state.scanning} />
      <Notice error={state.error} />
      <Sources sources={state.sources} />
      <ServerGroup title="Detected MCP servers" servers={detected} state={state} />
      <ManualServerForm form={state.form} saving={state.saving} setForm={state.setForm} submit={state.addManualServer} />
      <ServerGroup title="Manual MCP servers" servers={manual} state={state} showForget />
      <Capabilities capabilities={state.capabilities} onToggle={state.toggleCapability} />
    </section>
  );
}

function useMcpManagementState() {
  const [capabilities, setCapabilities] = useState([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [servers, setServers] = useState([]);
  const [sources, setSources] = useState([]);
  const loadAll = () => loadMcpState({ setCapabilities, setError, setLoading, setServers, setSources });
  const scan = () => scanMcp({ loadAll, setError, setScanning });
  const addManualServer = (event) => createManualServer(event, { form, loadAll, setError, setForm, setSaving });
  const toggleServer = (server) => patchServer(server.id, { enabled: !server.enabled }, { loadAll, setError });
  const introspectServer = (server) => introspectServerCapabilities(server.id, { loadAll, setError });
  const forgetServer = (server) => forgetDisabledServer(server, { loadAll, setError });
  const toggleCapability = (capability) => patchCapability(capability.id, { enabled: !capability.enabled }, { loadAll, setError });
  useEffect(() => { loadAll(); }, []);
  return { addManualServer, capabilities, error, form, forgetServer, introspectServer, loadAll, loading, saving, scan, scanning, servers, setForm, sources, toggleCapability, toggleServer };
}

function PanelHeader({ loading, onRefresh, onScan, scanning }) {
  return (
    <div style={{ alignItems: 'flex-start', display: 'flex', gap: '12px', justifyContent: 'space-between', flexWrap: 'wrap' }}>
      <div>
        <h2 style={{ alignItems: 'center', display: 'flex', fontSize: '1.1rem', fontWeight: 700, gap: '8px' }}>
          <PlugZap size={18} color="var(--primary)" /> MCP discovery & access
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '4px' }}>
          发现不等于启用；Supervisor 只会使用你显式启用的 server 和 capability，secret/env/header 始终显示为 {redactedText}。
        </p>
      </div>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <button className="btn btn-secondary" disabled={loading || scanning} onClick={onRefresh} type="button"><RefreshCw size={14} /> Refresh</button>
        <button className="btn btn-primary" disabled={scanning} onClick={onScan} type="button">{scanning ? 'Scanning...' : 'Scan local MCP configs'}</button>
      </div>
    </div>
  );
}

function Notice({ error }) {
  return (
    <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-light)', borderRadius: '14px', padding: '12px' }}>
      <strong><ShieldCheck size={15} /> 安全边界</strong>
      <div style={{ color: error ? 'var(--error)' : 'var(--text-muted)', fontSize: '0.8rem', marginTop: '6px' }}>
        {error || '扫描只读取 allowlisted 配置文件；stdio 可 introspect，HTTP/SSE 暂只保存配置和 diagnostics，不会假装可调用。'}
      </div>
    </div>
  );
}

function Sources({ sources }) {
  if (!sources.length) return null;
  return (
    <div style={{ display: 'grid', gap: '8px', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
      {sources.map((source) => <SourceCard key={source.id} source={source} />)}
    </div>
  );
}

function SourceCard({ source }) {
  const visible = (source.paths || []).filter((path) => path.exists).length;
  return (
    <div style={miniCardStyle}>
      <strong>{source.id}</strong>
      <span style={mutedStyle}>{visible ? `${visible} 个本机来源可见` : '未发现本机配置文件'}</span>
    </div>
  );
}

function ServerGroup({ servers, showForget = false, state, title }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <h3 style={sectionTitleStyle}>{title}</h3>
      {servers.length === 0 ? <div style={mutedStyle}>暂无记录。</div> : servers.map((server) => <ServerCard key={server.id} server={server} showForget={showForget} state={state} />)}
    </div>
  );
}

function ServerCard({ server, showForget, state }) {
  return (
    <div style={rowCardStyle}>
      <div style={{ minWidth: 0 }}>
        <strong>{server.name || server.id}</strong>
        <div style={mutedStyle}>{server.source} · {server.transport_type} · {server.enabled ? 'enabled' : 'disabled by default'} · {server.readiness || 'not_introspected'}</div>
        <Diagnostics diagnostics={server.diagnostics} />
      </div>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <button className="btn btn-secondary" onClick={() => state.introspectServer(server)} type="button">Inspect server capabilities</button>
        <button className="btn btn-secondary" onClick={() => state.toggleServer(server)} type="button">{server.enabled ? 'Disable server' : 'Enable for Supervisor'}</button>
        {showForget && !server.enabled && <button className="btn btn-secondary" onClick={() => state.forgetServer(server)} type="button">Forget</button>}
      </div>
    </div>
  );
}

function ManualServerForm({ form, saving, setForm, submit }) {
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <h3 style={sectionTitleStyle}>Manual MCP servers</h3>
      <div style={{ display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <TextField label="Name" onChange={(value) => update('name', value)} placeholder="Fixture MCP" value={form.name} />
        <TextField label="stdio command" onChange={(value) => update('command', value)} placeholder="node /path/server.js" value={form.command} />
        <TextField label="args" onChange={(value) => update('args', value)} placeholder="--flag value" value={form.args} />
        <TextField label="env allowlist (KEY=value)" onChange={(value) => update('envKeys', value)} placeholder="API_TOKEN=sk_xxx, MCP_HOME=/tmp" value={form.envKeys} />
      </div>
      <button className="btn btn-primary" disabled={saving || !form.name || !form.command} type="submit">{saving ? 'Saving...' : 'Add manual stdio server'}</button>
    </form>
  );
}

function Capabilities({ capabilities, onToggle }) {
  const groups = useMemo(() => groupCapabilities(capabilities), [capabilities]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <h3 style={sectionTitleStyle}>Capabilities</h3>
      {Object.entries(groups).map(([label, items]) => <CapabilityGroup key={label} items={items} label={label} onToggle={onToggle} />)}
    </div>
  );
}

function CapabilityGroup({ items, label, onToggle }) {
  if (!items.length) return null;
  return <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}><strong>{label}</strong>{items.map((capability) => <CapabilityRow capability={capability} key={capability.id} onToggle={onToggle} />)}</div>;
}

function CapabilityRow({ capability, onToggle }) {
  return (
    <div style={rowCardStyle}>
      <div>
        <strong>{capability.name}</strong>
        <div style={mutedStyle}>{capability.kind} · {capability.permission} · risk {capability.risk_level} · {capability.enabled ? 'enabled' : 'disabled'}</div>
      </div>
      <button className="btn btn-secondary" onClick={() => onToggle(capability)} type="button">{capability.enabled ? 'Disable' : 'Enable selected read-only resources/tools'}</button>
    </div>
  );
}

function Diagnostics({ diagnostics = [] }) {
  if (!diagnostics.length) return null;
  return <div style={{ ...mutedStyle, color: 'var(--warning)' }}>{diagnostics.map((item) => item.message || item.code).join(' · ')}</div>;
}

function TextField({ label, onChange, placeholder, value }) {
  return <label className="form-group" style={{ marginBottom: 0 }}><span>{label}</span><input className="form-control" onChange={(event) => onChange(event.target.value)} placeholder={placeholder} value={value} /></label>;
}

async function loadMcpState(setters) {
  setters.setLoading(true);
  try {
    const [sources, results] = await Promise.all([connectorsApi.getPiMcpDiscoverySources(), connectorsApi.getPiMcpDiscoveryResults()]);
    setters.setSources(sources.sources || []);
    setters.setServers(results.servers || []);
    setters.setCapabilities(results.capabilities || []);
    setters.setError('');
  } catch (err) { setters.setError(err.message || '加载 MCP 管理状态失败'); }
  finally { setters.setLoading(false); }
}

async function scanMcp({ loadAll, setError, setScanning }) {
  setScanning(true);
  try { await connectorsApi.scanPiMcpDiscovery({}); message.success('MCP discovery scan 已完成'); await loadAll(); }
  catch (err) { setError(err.message || 'MCP discovery scan 失败'); }
  finally { setScanning(false); }
}

async function createManualServer(event, state) {
  event.preventDefault();
  state.setSaving(true);
  try {
    await connectorsApi.createPiMcpServer({ name: state.form.name, transport: { args: splitWords(state.form.args), command: state.form.command, env: envPlaceholders(state.form.envKeys), type: 'stdio' } });
    state.setForm(emptyForm); message.success('Manual MCP server 已添加'); await state.loadAll();
  } catch (err) { state.setError(err.message || '添加 MCP server 失败'); }
  finally { state.setSaving(false); }
}

async function patchServer(id, patch, { loadAll, setError }) {
  try { await connectorsApi.patchPiMcpServer(id, patch); await loadAll(); }
  catch (err) { setError(err.message || '更新 MCP server 失败'); }
}

async function introspectServerCapabilities(id, { loadAll, setError }) {
  try { await connectorsApi.introspectPiMcpServer(id); await loadAll(); }
  catch (err) { setError(err.message || 'Inspect MCP server capabilities 失败'); }
}

async function patchCapability(id, patch, { loadAll, setError }) {
  try { await connectorsApi.patchPiMcpCapability(id, patch); await loadAll(); }
  catch (err) { setError(err.message || '更新 MCP capability 失败'); }
}

async function forgetDisabledServer(server, { loadAll, setError }) {
  if (server.enabled) return;
  try { await connectorsApi.deletePiMcpServer(server.id); await loadAll(); }
  catch (err) { setError(err.message || 'Forget MCP server 失败'); }
}

function groupCapabilities(items) {
  return { 'Read-only': items.filter((item) => item.read_only), 'Write/Admin or high risk': items.filter((item) => !item.read_only) };
}

function splitWords(value) {
  return value.split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function envPlaceholders(value) {
  return Object.fromEntries(value.split(/[,\n]+/).map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return index > 0 ? [part.slice(0, index).trim(), part.slice(index + 1).trim()] : [part, ''];
  }).filter(([key]) => key));
}

const sectionTitleStyle = { fontSize: '0.95rem', fontWeight: 800, margin: 0 };
const mutedStyle = { color: 'var(--text-muted)', fontSize: '0.78rem', wordBreak: 'break-word' };
const miniCardStyle = { background: 'var(--bg-secondary)', border: '1px solid var(--border-light)', borderRadius: '12px', display: 'flex', flexDirection: 'column', gap: '4px', padding: '10px' };
const rowCardStyle = { alignItems: 'center', border: '1px solid var(--border-light)', borderRadius: '14px', display: 'flex', gap: '12px', justifyContent: 'space-between', padding: '12px', flexWrap: 'wrap' };
