const percentage = value => typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : '—';
const count = value => typeof value === 'number' && Number.isFinite(value) ? value : '—';

export const RANGE_OPTIONS = [7, 30, 90];

export function effectivenessFacts(data) {
  return [
    { label: '结束任务', value: count(data.sampled_works), detail: `其中 ${data.completed_works ?? '—'} 个已完成` },
    { label: '交付通过率', value: percentage(data.delivery_rate), detail: `${data.delivered_works ?? '—'} / ${data.sampled_works ?? '—'} 个通过交付验证` },
    { label: '请求协助', value: count(data.help_requested_works), detail: '执行中发起过审批或待你处理' },
    { label: '完成用时中位数', value: metricDuration(data.duration?.median_ms), detail: '从开始执行到结束' },
    { label: '执行费用', value: currencySubtotal(data.execution_cost), detail: `${data.execution_cost?.known_works ?? '—'} 个任务有费用记录` },
  ];
}

export function diagnosticFacts(data) {
  const reflection = data.supervisor?.reflection;
  return [
    { label: '重复执行的任务', value: count(data.recovery?.repeated_run_works), detail: '执行过两次及以上' },
    { label: '恢复后通过率', value: percentage(data.recovery?.delivery_rate), detail: `${data.recovery?.delivered_works ?? '—'} / ${data.recovery?.works ?? '—'} 个恢复任务` },
    { label: '多次恢复仍无进展', value: count(data.recovery?.repeated_no_progress_works), detail: `累计 ${data.recovery?.no_progress_attempts ?? '—'} 次无进展` },
    { label: '执行间隔合计', value: metricDuration(data.waiting?.run_gap_ms), detail: '同一任务两次执行之间的空档' },
    { label: '审批等待合计', value: metricDuration(data.waiting?.approval_recorded_ms), detail: '可能与执行间隔重叠' },
    { label: '记忆注入 / 引用', value: `${data.memory?.injected_works ?? '—'} / ${data.memory?.cited_works ?? '—'}`, detail: '有记录的任务数' },
    { label: '复盘费用', value: reflection?.known_cost_usd == null ? '—' : `USD ${reflection.known_cost_usd.toFixed(2)}`, detail: `${reflection?.recorded_attempts ?? '—'} 次复盘的 SDK 估算` },
  ];
}

export const currencySubtotal = cost => cost?.by_currency?.length
  ? cost.by_currency.map(item => `${item.currency} ${(item.amount_micros / 1e6).toFixed(2)}`).join(' / ') : '—';

export function metricDuration(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const minutes = Math.round(value / 60000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = minutes / 60;
  return hours < 48 ? `${hours.toFixed(1)} 小时` : `${(hours / 24).toFixed(1)} 天`;
}

// 按本地时区的自然日取最近 N 天，含今天；夏令时多出的一小时不得超过接口的 N 天上限。
export function deliveryRange(days, now = new Date()) {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - 1;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1).getTime();
  return { from: new Date(Math.max(start, end + 1 - days * 86400000)).toISOString(), to: new Date(end).toISOString() };
}
