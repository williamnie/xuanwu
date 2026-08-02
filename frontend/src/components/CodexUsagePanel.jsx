import { systemApi } from '../api/system.js';
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, RefreshCw, Zap } from 'lucide-react';
import { readCodexUsageCache, writeCodexUsageCache } from '../utils/codexUsageCache.js';
import CodexUsageBreakdown from './CodexUsageBreakdown';
import {
  availableUsageProviders,
  providerUsageReport,
  readSelectedUsageProvider,
  selectedUsageProvider,
  writeSelectedUsageProvider,
} from './providerUsageModel.js';
import './CodexUsagePanel.css';
import './CodexUsagePanel.details.css';

export default function CodexUsagePanel() {
  const [state, setState] = useState(() => ({ loading: true, data: readCodexUsageCache(), status: null, error: '' }));
  const [selectedProviderID, setSelectedProviderID] = useState(readSelectedUsageProvider);

  const loadUsage = useCallback(async (isActive = () => true) => {
    if (!isActive()) return;
    setState(prev => ({ ...prev, loading: true, error: '' }));
    try {
      const [data, status] = await Promise.all([
        systemApi.getProviderUsage({ compact: true, refresh: true }),
        systemApi.getSystemStatus({ force: true }),
      ]);
      writeCodexUsageCache(data);
      if (!isActive()) return;
      setState({ loading: false, data, status, error: '' });
    } catch (err) {
      if (!isActive()) return;
      setState(prev => ({
        ...prev,
        loading: false,
        error: err.message || '读取 Provider 用量失败',
      }));
    }
  }, []);

  useEffect(() => {
    let active = true;
    void loadUsage(() => active);
    return () => { active = false; };
  }, [loadUsage]);

  const { data, error, loading, status } = state;
  const providers = availableUsageProviders(status, data);
  const selectedProvider = selectedUsageProvider(providers, selectedProviderID);
  const selectedUsage = providerUsageReport(data, selectedProvider?.id);
  const selectProvider = (providerID) => {
    setSelectedProviderID(providerID);
    writeSelectedUsageProvider(providerID);
  };
  return (
    <section className="glass-card codex-usage-panel">
      <UsageHeader
        data={data}
        loading={loading}
        onProviderChange={selectProvider}
        onRefresh={loadUsage}
        providers={providers}
        selectedProvider={selectedProvider}
      />
      {error ? <UsageError message={error} /> : null}
      <UsageContent data={selectedUsage} loading={loading} piUsage={data?.pi_usage} provider={selectedProvider} />
    </section>
  );
}

function UsageHeader({ data, loading, onProviderChange, onRefresh, providers, selectedProvider }) {
  return (
    <header className="codex-usage-header">
      <div>
        <h3><Zap size={18} /> AI 用量</h3>
        <p>展示当前启用 Provider 的今日用量、账户额度与 PI 消耗。</p>
      </div>
      <div className="codex-usage-actions">
        {providers.length > 1 ? (
          <label className="codex-provider-select">
            <span className="codex-visually-hidden">当前 Provider</span>
            <select value={selectedProvider?.id || ''} onChange={(event) => onProviderChange(event.target.value)}>
              {providers.map(provider => <option key={provider.id} value={provider.id}>{provider.label || provider.id}</option>)}
            </select>
          </label>
        ) : selectedProvider ? <span className="codex-provider-badge">{selectedProvider.label || selectedProvider.id}</span> : null}
        <span>{formatUpdatedAt(data?.generated_at)}</span>
        <button className="btn btn-secondary" onClick={() => onRefresh()} disabled={loading} type="button">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          {loading ? '刷新中' : '刷新'}
        </button>
      </div>
    </header>
  );
}

function UsageContent({ data, loading, piUsage, provider }) {
  if (loading && !data) {
    return <div className="codex-usage-loading">正在读取 Provider 用量…</div>;
  }
  if (!provider) return <div className="codex-usage-empty">当前没有可展示的 Provider，请先完成 Provider 配置。</div>;
  if (!data) return <div className="codex-usage-empty">当前 Provider 暂无用量数据。</div>;
  return (
    <div className="codex-usage-content">
      <ProviderUsageRow data={data} provider={provider} />
      <PiTodayUsage data={piUsage} />
      <UsageDetails data={data} />
    </div>
  );
}

function UsageError({ message }) {
  return <div className="codex-usage-error">暂时无法更新用量：{message}</div>;
}

function ProviderUsageRow({ data, provider }) {
  const today = data.summary?.today;
  const limits = [data.rate_limits?.primary, data.rate_limits?.secondary].filter(Boolean);
  const usageAvailable = data.events_scanned > 0 && today?.completeness !== 'unavailable';
  return (
    <article className="codex-provider-usage-row">
      <div className="codex-provider-identity">
        <strong>{provider.label || provider.id}</strong>
        <span className={providerAvailable(provider) ? 'is-available' : 'is-unavailable'}>
          {providerAvailable(provider) ? '可用' : '需配置'}
        </span>
      </div>
      <CompactMetric label={data.provider?.scope === 'runner_attempts' ? 'Runner 今日' : '今日'} value={usageAvailable ? formatTokens(today?.total_tokens || 0) : '—'} />
      {today?.money?.amount_micros != null ? (
        <CompactMetric label="今日成本" value={formatMoney(today.money)} />
      ) : null}
      <div className="codex-compact-limits">
        {limits.length > 0
          ? limits.map((window, index) => <CompactLimit key={`${window.window_minutes || index}`} kind={index === 0 ? 'primary' : 'secondary'} window={window} />)
          : <span className="codex-no-limit">未提供账户额度</span>}
      </div>
    </article>
  );
}

function CompactMetric({ label, value }) {
  return <div className="codex-compact-metric"><span>{label}</span><strong>{value}</strong></div>;
}

function CompactLimit({ kind, window }) {
  const used = clamp(window.used_percent || 0, 0, 100);
  const remaining = clamp(window.remaining_percent ?? 100 - used, 0, 100);
  return (
    <div className={`codex-compact-limit ${limitTone(used)}`}>
      <span>{windowTitle(kind, window)}</span>
      <div
        aria-label={`${windowTitle(kind, window)}已使用 ${used.toFixed(1)}%`}
        aria-valuemax="100"
        aria-valuemin="0"
        aria-valuenow={used}
        className="codex-limit-track"
        role="progressbar"
      >
        <span style={{ width: `${used}%` }} />
      </div>
      <strong>{remaining.toFixed(0)}% 可用</strong>
      <small>{formatResetTime(window.resets_at_iso)}</small>
    </div>
  );
}

function PiTodayUsage({ data }) {
  const piToday = data?.status === 'unavailable'
    ? '—'
    : formatTokens(data?.summary?.today?.total_tokens || 0);
  return (
    <div className="codex-today-usage">
      <div><span>PI 今日总消耗</span><strong>{piToday}</strong></div>
      <p>数据范围：Runner PI 会话</p>
    </div>
  );
}

function UsageDetails({ data }) {
  return (
    <details className="codex-usage-details">
      <summary>
        <span>
          <strong>查看用量详情</strong>
          <small>周期汇总、Project 归因与输入/输出拆分</small>
        </span>
        <ChevronDown size={16} />
      </summary>
      <div className="codex-usage-details-body">
        <SummaryGrid summary={data.summary} />
        <CodexUsageBreakdown projects={data.project_usage || []} />
      </div>
    </details>
  );
}

function SummaryGrid({ summary }) {
  const cards = [
    ['本周', summary?.this_week],
    ['本月', summary?.this_month],
    ['累计', summary?.all_time],
  ];
  return (
    <div className="codex-summary-grid">
      {cards.map(([label, usage]) => <TokenStat key={label} label={label} usage={usage} />)}
    </div>
  );
}

function TokenStat({ label, usage }) {
  return (
    <div className="codex-token-stat">
      <span>{label}</span>
      <strong>{formatTokens(usage?.total_tokens || 0)}</strong>
      <small>输入 {formatTokens(usage?.input_tokens || 0)} · 输出 {formatTokens(usage?.output_tokens || 0)}</small>
    </div>
  );
}

function windowTitle(kind, window) {
  if (window?.window_minutes === 300) return '5 小时限额';
  if (window?.window_minutes === 10080) return '周限额';
  return kind === 'primary' ? '主限额' : '次级限额';
}

function providerAvailable(provider) {
  return provider.available === true || provider.ready === true || provider.status === 'available';
}

function formatTokens(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return new Intl.NumberFormat('zh-CN').format(value || 0);
}

function formatMoney(money) {
  if (money?.amount_micros == null || !money.currency) return '—';
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: money.currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(money.amount_micros / 1_000_000);
}

function formatUpdatedAt(value) {
  if (!value) return '等待更新';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '更新时间未知';
  return `更新于 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
}

function formatResetTime(value) {
  if (!value) return '重置时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '重置时间未知';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const resetDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((resetDay.getTime() - today.getTime()) / 86_400_000);
  const dayLabel = days === 0 ? '今天' : days === 1 ? '明天' : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return `${dayLabel} ${time} 重置`;
}

function limitTone(used) {
  if (used >= 90) return 'is-critical';
  if (used >= 70) return 'is-warning';
  return 'is-healthy';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
