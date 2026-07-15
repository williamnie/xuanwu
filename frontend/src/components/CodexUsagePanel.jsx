import { systemApi } from '../api/system.js';
import { useCallback, useEffect, useState } from 'react';
import { BarChart3, ChevronDown, Gauge, RefreshCw, Zap } from 'lucide-react';
import CodexUsageBreakdown from './CodexUsageBreakdown';
import './CodexUsagePanel.css';
import './CodexUsagePanel.details.css';

export default function CodexUsagePanel() {
  const [state, setState] = useState({ loading: true, data: null, error: '' });

  const loadUsage = useCallback(async () => {
    setState(prev => ({ ...prev, loading: true, error: '' }));
    try {
      const data = await systemApi.getCodexUsage();
      setState({ loading: false, data, error: '' });
    } catch (err) {
      setState(prev => ({
        ...prev,
        loading: false,
        error: err.message || '读取 Codex 用量失败',
      }));
    }
  }, []);

  useEffect(() => {
    loadUsage();
    const timer = setInterval(loadUsage, 60_000);
    return () => clearInterval(timer);
  }, [loadUsage]);

  const { data, error, loading } = state;
  return (
    <section className="glass-card codex-usage-panel">
      <UsageHeader data={data} loading={loading} onRefresh={loadUsage} />
      {error ? <UsageError message={error} /> : null}
      <UsageContent data={data} loading={loading} />
    </section>
  );
}

function UsageHeader({ data, loading, onRefresh }) {
  return (
    <header className="codex-usage-header">
      <div>
        <h3><Zap size={18} /> Codex 用量</h3>
        <p>优先展示当前可用额度，需要时再查看历史与项目明细。</p>
      </div>
      <div className="codex-usage-actions">
        <span>{formatUpdatedAt(data?.generated_at)}</span>
        <button className="btn btn-secondary" onClick={onRefresh} disabled={loading} type="button">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          {loading ? '刷新中' : '刷新'}
        </button>
      </div>
    </header>
  );
}

function UsageContent({ data, loading }) {
  if (loading && !data) {
    return <div className="codex-usage-loading">正在读取 Codex 用量…</div>;
  }
  if (!data || data.events_scanned === 0) return <EmptyUsage />;
  return (
    <div className="codex-usage-content">
      <LimitGrid limits={data.rate_limits} />
      <TodayUsage usage={data.summary?.today} />
      <UsageDetails data={data} />
    </div>
  );
}

function UsageError({ message }) {
  return <div className="codex-usage-error">暂时无法更新用量：{message}</div>;
}

function EmptyUsage() {
  return (
    <div className="codex-usage-empty">
      暂无用量记录。Codex 产生新的响应后会自动显示在这里。
    </div>
  );
}

function LimitGrid({ limits }) {
  if (!limits) {
    return <div className="codex-usage-empty">暂未捕获到 Codex 限额快照。</div>;
  }
  return (
    <div className="codex-limit-grid">
      <LimitCard title={windowTitle('primary', limits.primary)} window={limits.primary} planType={limits.plan_type} />
      <LimitCard title={windowTitle('secondary', limits.secondary)} window={limits.secondary} planType={limits.plan_type} />
    </div>
  );
}

function LimitCard({ title, window, planType }) {
  if (!window) return <div className="codex-limit-card is-empty">{title}：暂无数据</div>;
  const used = clamp(window.used_percent || 0, 0, 100);
  const remaining = clamp(window.remaining_percent ?? 100 - used, 0, 100);
  return (
    <article className={`codex-limit-card ${limitTone(used)}`}>
      <div className="codex-limit-card-head">
        <span><Gauge size={16} /> {title}</span>
        {planType ? <span className="codex-plan-badge">{String(planType).toUpperCase()}</span> : null}
      </div>
      <div className="codex-limit-remaining">
        <strong>{remaining.toFixed(0)}%</strong><span>可用</span>
      </div>
      <div
        aria-label={`${title}已使用 ${used.toFixed(1)}%`}
        aria-valuemax="100"
        aria-valuemin="0"
        aria-valuenow={used}
        className="codex-limit-track"
        role="progressbar"
      >
        <span style={{ width: `${used}%` }} />
      </div>
      <div className="codex-limit-meta">
        <span>已用 {used.toFixed(1)}%</span>
        <span>{formatResetTime(window.resets_at_iso)}</span>
      </div>
    </article>
  );
}

function TodayUsage({ usage }) {
  return (
    <div className="codex-today-usage">
      <div>
        <span>今日用量</span>
        <strong>{formatTokens(usage?.total_tokens || 0)}</strong>
      </div>
      <p>本地 Codex session 统计，仅用于观察工作量趋势。</p>
    </div>
  );
}

function UsageDetails({ data }) {
  return (
    <details className="codex-usage-details">
      <summary>
        <span>
          <strong>查看用量详情</strong>
          <small>历史趋势、Project 归因与输入/输出拆分</small>
        </span>
        <ChevronDown size={16} />
      </summary>
      <div className="codex-usage-details-body">
        <SummaryGrid summary={data.summary} />
        <CodexUsageBreakdown projects={data.project_usage || []} />
        <div className="codex-usage-detail-columns">
          <DailyBars periods={data.daily || []} />
          <PeriodLists weekly={data.weekly || []} monthly={data.monthly || []} />
        </div>
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

function DailyBars({ periods }) {
  const latest = periods.slice(-7);
  const max = Math.max(1, ...latest.map(period => period.usage?.total_tokens || 0));
  return (
    <div className="codex-detail-panel">
      <h4><BarChart3 size={16} /> 最近 7 天</h4>
      <div className="codex-daily-bars">
        {latest.map(period => <UsageBar key={period.key} period={period} max={max} />)}
      </div>
    </div>
  );
}

function UsageBar({ period, max }) {
  const total = period.usage?.total_tokens || 0;
  return (
    <div className="codex-usage-bar">
      <span>{period.label}</span>
      <div><span style={{ width: `${Math.max(2, (total / max) * 100)}%` }} /></div>
      <strong>{formatTokens(total)}</strong>
    </div>
  );
}

function PeriodLists({ weekly, monthly }) {
  return (
    <div className="codex-detail-panel codex-period-lists">
      <CompactPeriods title="周统计" periods={weekly.slice(-4)} />
      <CompactPeriods title="月统计" periods={monthly.slice(-4)} />
    </div>
  );
}

function CompactPeriods({ title, periods }) {
  return (
    <div>
      <h4>{title}</h4>
      {periods.map(period => (
        <div className="codex-period-row" key={period.key}>
          <span>{period.label}</span>
          <strong>{formatTokens(period.usage?.total_tokens || 0)}</strong>
        </div>
      ))}
    </div>
  );
}

function windowTitle(kind, window) {
  if (window?.window_minutes === 300) return '5 小时限额';
  if (window?.window_minutes === 10080) return '周限额';
  return kind === 'primary' ? '主限额' : '次级限额';
}

function formatTokens(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return new Intl.NumberFormat('zh-CN').format(value || 0);
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
