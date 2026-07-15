import { systemApi } from '../api/system.js';
import { useEffect, useState } from 'react';
import { KeyRound, RefreshCw } from 'lucide-react';
import { PanelLoader } from '../components/TurtleLoader';

export default function ProviderAvailabilityPanel() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => { loadStatus(setStatus, setError, setLoading); }, []);

  const providers = status?.providers || [];
  return (
    <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <PanelHeader loading={loading} onRefresh={() => loadStatus(setStatus, setError, setLoading)} />
      {error && <div style={{ color: 'var(--error)', fontSize: '0.86rem' }}>{error}</div>}
      {!error && <ProviderBody loading={loading} status={status} providers={providers} />}
    </section>
  );
}

function loadStatus(setStatus, setError, setLoading) {
  setLoading(true);
  systemApi.getSystemStatus()
    .then(data => { setStatus(data); setError(''); })
    .catch(err => setError(err.message || '读取 provider 状态失败'))
    .finally(() => setLoading(false));
}

function PanelHeader({ loading, onRefresh }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'center' }}>
      <div>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <KeyRound size={18} color="var(--primary)" /> Provider Settings
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '4px' }}>
          只显示 CLI 路径和 secret 是否已配置；不会返回 token/API key 明文。
        </p>
      </div>
      <button className="btn btn-secondary" onClick={onRefresh} disabled={loading}>
        <RefreshCw size={15} className={loading ? 'spin-animation' : ''} />
        刷新
      </button>
    </div>
  );
}

function ProviderBody({ loading, status, providers }) {
  if (loading && !status) {
    return <PanelLoader label="正在确认 Provider 状态…" />;
  }
  if (providers.length === 0) {
    return <div style={{ color: 'var(--text-muted)', fontSize: '0.86rem' }}>暂无 provider 状态</div>;
  }
  return <ProviderGrid providers={providers} />;
}

function ProviderGrid({ providers }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px' }}>
      {providers.map(provider => <ProviderCard key={provider.id} provider={provider} />)}
    </div>
  );
}

function ProviderCard({ provider }) {
  const ok = provider.status === 'available';
  const statusColor = ok ? 'var(--success)' : 'var(--text-muted)';
  return (
    <div style={{ border: '1px solid var(--border-light)', borderRadius: '14px', padding: '14px', background: 'var(--bg-secondary)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' }}>
        <div style={{ fontWeight: 800 }}>{provider.label || provider.id}</div>
        <span style={{ color: statusColor, fontSize: '0.78rem', fontWeight: 700 }}>
          {providerStatusLabel(provider)}
        </span>
      </div>
      <ProviderMeta label="CLI" value={providerCLIText(provider)} ok={provider.cli?.available} />
      {provider.cli?.version && <ProviderMeta label="Version" value={provider.cli.version} ok={provider.cli?.available} />}
      <ProviderMeta label="API key/token" value={secretStatusLabel(provider.secrets?.api_key)} ok={provider.secrets?.api_key?.configured} />
      <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', lineHeight: 1.5 }}>
        {provider.enabled ? `已启用：${providerCapabilityText(provider)}` : '仅展示配置状态，暂不启用执行'}
      </div>
    </div>
  );
}

function providerCapabilityText(provider) {
  const capabilities = provider.capabilities || [];
  if (capabilities.includes('issue_execution')) return 'Issue execution only';
  return '未声明 capability';
}

function ProviderMeta({ label, value, ok }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.84rem', wordBreak: 'break-word' }}>
        <span className={`status-dot ${ok ? 'active' : 'idle'}`} style={{ width: '7px', height: '7px', flex: '0 0 auto' }}></span>
        {value}
      </span>
    </div>
  );
}

function providerCLIText(provider) {
  return provider.cli?.path || provider.cli?.command || provider.cli?.error || '未配置';
}

function providerStatusLabel(provider) {
  if (provider.status === 'available') return 'available';
  if (provider.status === 'missing') return 'missing';
  return 'unknown';
}

function secretStatusLabel(secret) {
  if (!secret) return '未声明';
  return secret.configured ? '已配置' : '未配置';
}
