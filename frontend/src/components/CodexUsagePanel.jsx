import { useCallback, useEffect, useState } from 'react';
import { BarChart3, Gauge, RefreshCw, Zap } from 'lucide-react';
import { api } from '../api/client';
import CodexUsageBreakdown from './CodexUsageBreakdown';

const USAGE_LIMITS = [
  { value: 0, label: '全部事件' },
  { value: 50, label: '最近 50 条' },
  { value: 200, label: '最近 200 条' },
  { value: 500, label: '最近 500 条' },
];

export default function CodexUsagePanel() {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const [limit, setLimit] = useState(0);

  const loadUsage = useCallback(async () => {
    setState(prev => ({ ...prev, loading: true, error: '' }));
    try {
      const data = await api.getCodexUsage(limit);
      setState({ loading: false, data, error: '' });
    } catch (err) {
      setState({ loading: false, data: null, error: err.message || '读取 Codex 用量失败' });
    }
  }, [limit]);

  useEffect(() => {
    loadUsage();
    const timer = setInterval(loadUsage, 60_000);
    return () => clearInterval(timer);
  }, [loadUsage]);

  const { data, error, loading } = state;

  return (
    <section className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      <UsageHeader loading={loading} limit={limit} onLimitChange={setLimit} onRefresh={loadUsage} />
      {error ? <UsageError message={error} /> : <UsageContent data={data} loading={loading} />}
    </section>
  );
}

function UsageHeader({ loading, limit, onLimitChange, onRefresh }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'flex-start' }}>
      <div>
        <h3 style={{ fontSize: '1.2rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Zap size={18} color="var(--primary)" /> Codex Token 与限额
        </h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '4px' }}>
          从本机 Codex session 事件统计，展示每日、周、月 token 量与最新 5 小时/周限额。
        </p>
      </div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <select className="form-control" value={limit} onChange={(event) => onLimitChange(Number(event.target.value))} style={{ width: '130px', padding: '7px 10px', fontSize: '0.8rem' }}>
          {USAGE_LIMITS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <button className="btn btn-secondary" onClick={onRefresh} disabled={loading} style={{ padding: '7px 12px', fontSize: '0.8rem' }}>
          <RefreshCw size={14} /> {loading ? '刷新中' : '刷新'}
        </button>
      </div>
    </div>
  );
}

function UsageContent({ data, loading }) {
  if (loading && !data) {
    return <div style={{ color: 'var(--text-muted)', padding: '16px 0' }}>正在读取 Codex 用量日志...</div>;
  }
  if (!data || data.events_scanned === 0) {
    return <EmptyUsage source={data?.source} />;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      <SummaryGrid summary={data.summary} eventsScanned={data.events_scanned} />
      <LimitGrid limits={data.rate_limits} />
      <CodexUsageBreakdown projects={data.project_usage || []} />
      <div className="grid-cols-2" style={{ alignItems: 'stretch' }}>
        <DailyBars periods={data.daily || []} />
        <PeriodLists weekly={data.weekly || []} monthly={data.monthly || []} source={data.source} />
      </div>
    </div>
  );
}

function UsageError({ message }) {
  return (
    <div style={{ background: 'var(--warning-bg)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: '8px', padding: '14px 16px', color: 'var(--text-secondary)' }}>
      暂时无法读取 Codex 用量：{message}
    </div>
  );
}

function EmptyUsage({ source }) {
  return (
    <div style={{ border: '1px dashed var(--border-color)', borderRadius: '8px', padding: '18px', color: 'var(--text-muted)' }}>
      暂无 `token_count` 事件。Codex 产生新的响应后会自动出现在这里。
      {source ? <div style={{ marginTop: '8px', fontSize: '0.75rem' }}>统计源：{source}</div> : null}
    </div>
  );
}

function SummaryGrid({ summary, eventsScanned }) {
  const cards = [
    ['今日', summary?.today],
    ['本周', summary?.this_week],
    ['本月', summary?.this_month],
    [`累计 · ${eventsScanned} 条事件`, summary?.all_time],
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '12px' }}>
      {cards.map(([label, usage]) => <TokenStat key={label} label={label} usage={usage} />)}
    </div>
  );
}

function TokenStat({ label, usage }) {
  return (
    <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '14px' }}>
      <div style={{ color: 'var(--text-muted)', fontSize: '0.76rem', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: '1.45rem', fontWeight: 800, marginTop: '8px' }}>{formatTokens(usage?.total_tokens || 0)}</div>
      <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem', marginTop: '6px' }}>
        输入 {formatTokens(usage?.input_tokens || 0)} · 输出 {formatTokens(usage?.output_tokens || 0)}
      </div>
    </div>
  );
}

function LimitGrid({ limits }) {
  if (!limits) {
    return <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>暂未捕获到 Codex 限额快照。</div>;
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px' }}>
      <LimitCard title={windowTitle('primary', limits.primary)} window={limits.primary} planType={limits.plan_type} />
      <LimitCard title={windowTitle('secondary', limits.secondary)} window={limits.secondary} planType={limits.plan_type} />
    </div>
  );
}

function LimitCard({ title, window, planType }) {
  if (!window) {
    return <div className="glass-card" style={{ boxShadow: 'none' }}>{title}：暂无</div>;
  }
  const used = clamp(window.used_percent || 0, 0, 100);
  return (
    <div style={{ background: 'linear-gradient(135deg, var(--bg-primary), var(--bg-card))', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700 }}>
          <Gauge size={16} color="var(--primary)" /> {title}
        </div>
        {planType ? <span className="status-badge todo">{planType}</span> : null}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '14px', fontSize: '0.85rem' }}>
        <span>已用 {used.toFixed(1)}%</span>
        <span style={{ color: 'var(--success)' }}>剩余 {clamp(window.remaining_percent || 0, 0, 100).toFixed(1)}%</span>
      </div>
      <div style={{ height: '8px', borderRadius: '999px', background: 'var(--border-color)', overflow: 'hidden', marginTop: '8px' }}>
        <div style={{ width: `${used}%`, height: '100%', borderRadius: '999px', background: limitColor(used) }} />
      </div>
      <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '10px' }}>
        重置：{formatDateTime(window.resets_at_iso)} · 窗口 {formatWindow(window.window_minutes)}
      </div>
    </div>
  );
}

function DailyBars({ periods }) {
  const latest = periods.slice(-7);
  const max = Math.max(1, ...latest.map(p => p.usage?.total_tokens || 0));
  return (
    <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '16px' }}>
      <h4 style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.95rem', marginBottom: '14px' }}>
        <BarChart3 size={16} color="var(--primary)" /> 最近 7 天
      </h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {latest.map(period => <UsageBar key={period.key} period={period} max={max} />)}
      </div>
    </div>
  );
}

function UsageBar({ period, max }) {
  const total = period.usage?.total_tokens || 0;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '88px 1fr 70px', gap: '10px', alignItems: 'center', fontSize: '0.78rem' }}>
      <span style={{ color: 'var(--text-muted)' }}>{period.label}</span>
      <div style={{ height: '8px', background: 'var(--border-color)', borderRadius: '999px', overflow: 'hidden' }}>
        <div style={{ width: `${Math.max(2, (total / max) * 100)}%`, height: '100%', background: 'var(--primary-gradient)' }} />
      </div>
      <span style={{ textAlign: 'right', fontWeight: 700 }}>{formatTokens(total)}</span>
    </div>
  );
}

function PeriodLists({ weekly, monthly, source }) {
  return (
    <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <CompactPeriods title="周统计" periods={weekly.slice(-4)} />
      <CompactPeriods title="月统计" periods={monthly.slice(-4)} />
      <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem', wordBreak: 'break-all' }}>统计源：{source}</div>
    </div>
  );
}

function CompactPeriods({ title, periods }) {
  return (
    <div>
      <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', fontWeight: 700, marginBottom: '8px' }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {periods.map(period => (
          <div key={period.key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem' }}>
            <span>{period.label}</span>
            <strong>{formatTokens(period.usage?.total_tokens || 0)}</strong>
          </div>
        ))}
      </div>
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

function formatWindow(minutes) {
  if (!minutes) return '—';
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function limitColor(used) {
  if (used >= 90) return 'var(--error)';
  if (used >= 70) return 'var(--warning)';
  return 'var(--primary-gradient)';
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
