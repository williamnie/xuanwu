import { systemApi } from '../api/system.js';
import { useEffect, useState } from 'react';
import { KeyRound, RefreshCw } from 'lucide-react';
import { PanelLoader } from '../components/TurtleLoader';
import { providerAuthenticationText, providerRuntimeText } from './providerAvailabilityModel.js';
import './ProviderAvailabilityPanel.css';

export default function ProviderAvailabilityPanel() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => { loadStatus(setStatus, setError, setLoading); }, []);

  const providers = status?.providers || [];
  return (
    <section className="glass-card provider-availability">
      <PanelHeader loading={loading} onRefresh={() => loadStatus(setStatus, setError, setLoading)} />
      {error && <div className="provider-availability__error">{error}</div>}
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
    <div className="provider-availability__header">
      <div>
        <h2 className="provider-availability__heading">
          <KeyRound size={18} color="var(--primary)" /> Provider Settings
        </h2>
        <p className="provider-availability__description">
          显示运行模式和安全认证摘要；不会返回 token、API key 或 credential 文件内容。
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
    return <div className="provider-availability__empty">暂无 provider 状态</div>;
  }
  return <ProviderGrid providers={providers} />;
}

function ProviderGrid({ providers }) {
  return (
    <div className="provider-availability__grid">
      {providers.map(provider => <ProviderCard key={provider.id} provider={provider} />)}
    </div>
  );
}

function ProviderCard({ provider }) {
  const ok = provider.status === 'available';
  return (
    <div className="provider-availability__card">
      <div className="provider-availability__card-header">
        <div className="provider-availability__card-title">{provider.label || provider.id}</div>
        <span className={`provider-availability__status${ok ? ' is-available' : ''}`}>
          {providerStatusLabel(provider)}
        </span>
      </div>
      <ProviderMeta label="Runtime" value={providerRuntimeText(provider)} ok={provider.ready ?? provider.cli?.available} />
      <ProviderMeta label="Auth" value={providerAuthenticationText(provider)} ok={provider.auth_configured ?? provider.secrets?.api_key?.configured} />
      {provider.id !== 'claude' && <ProviderMeta label="CLI" value={providerCLIText(provider)} ok={provider.cli?.available} />}
      <div className="provider-availability__capabilities">
        {provider.enabled ? `已启用：${providerCapabilityText(provider)}` : '仅展示配置状态，暂不启用执行'}
      </div>
    </div>
  );
}

function providerCapabilityText(provider) {
  const capabilities = provider.capabilities || [];
  if (capabilities.length > 0) return capabilities.join(', ');
  return '未声明 capability';
}

function ProviderMeta({ label, value, ok }) {
  return (
    <div className="provider-availability__meta">
      <span className="provider-availability__meta-label">{label}</span>
      <span className="provider-availability__meta-value">
        <span className={`status-dot provider-availability__dot ${ok ? 'active' : 'idle'}`}></span>
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
  if (provider.status === 'configuration_required') return 'configuration required';
  return 'unknown';
}
