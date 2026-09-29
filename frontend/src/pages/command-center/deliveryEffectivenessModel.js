const percentage = value => typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : '—';

export function effectivenessFacts(data) {
  return [
    { label: '交付验证通过率', value: percentage(data.delivery_rate), detail: data.sampled_works == null ? '交付与验证记录覆盖情况未知' : `${data.delivered_works ?? '未知'} / ${data.sampled_works} 个结束任务已完成且交付、验证记录齐全` },
    { label: '已完成任务', value: data.completed_works ?? '未知', detail: '任务已标为完成；交付验证通过才计入通过率' },
    { label: '请求协助的任务', value: data.help_requested_works ?? '未知', detail: data.intervention?.no_help_record_works == null ? '无求助记录的任务数未知；人工介入情况仍未知' : `${data.intervention.no_help_record_works} 个任务无求助记录；不代表没有人工介入` },
    { label: '完成用时中位数', value: metricMinutes(data.duration?.median_ms), detail: data.duration?.known_works == null ? '时间记录覆盖情况未知' : `${data.duration.known_works} 个完成任务有时间记录；不含缺失数据` },
  ];
}

export function costFacts(data) {
  const money = data.cost?.by_currency || [];
  return [
    { label: '任务执行金额（已知小计）', value: currencySubtotal(data.execution_cost), detail: `${data.execution_cost?.known_works ?? '未知'} / ${data.sampled_works ?? '未知'} 个结束任务有完整金额，包括失败和取消的任务` },
    { label: '每个完成任务平均金额', value: money.length ? money.map(item => `${item.currency} ${(item.mean_micros / 1e6).toFixed(4)}`).join(' / ') : '未知', detail: `${data.cost?.known_works ?? '未知'} 个已知 · ${data.cost?.unknown_works ?? '未知'} 个未知；不外推缺失金额` },
  ];
}

export function recoveryFacts(data) {
  return [
    { label: '恢复后交付验证通过率', value: percentage(data.recovery?.delivery_rate), detail: `${data.recovery?.delivered_works ?? '未知'} / ${data.recovery?.works ?? '未知'} 个恢复任务` },
    { label: '多次恢复仍无进展', value: data.recovery?.repeated_no_progress_works ?? '未知', detail: `累计 ${data.recovery?.no_progress_attempts ?? '未知'} 次无进展` },
  ];
}

export const currencySubtotal = cost => cost?.by_currency?.length
  ? cost.by_currency.map(item => `${item.currency} ${(item.amount_micros / 1e6).toFixed(4)}`).join(' / ') : '未知';

export const metricMinutes = value => typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value / 60000)} 分钟` : '未知';
export const metricMoney = cost => cost?.status === 'known' && Number.isFinite(cost.amount_micros) ? `${cost.currency} ${(cost.amount_micros / 1e6).toFixed(4)}` : '未知';
export function deliveryRange(days, now = new Date()) {
  return { from: `${new Date(now.getTime() - (days - 1) * 86400000).toISOString().slice(0, 10)}T00:00:00.000Z`,
    to: `${now.toISOString().slice(0, 10)}T23:59:59.999Z` };
}
export function overheadFacts(data) {
  const reflection = data.supervisor?.reflection;
  return [
    { label: '执行间隔记录', value: metricMinutes(data.waiting?.run_gap_ms), detail: `${data.waiting?.run_gap_known_works ?? '未知'} 个任务时间完整；总等待未知` },
    { label: '审批记录时长', value: metricMinutes(data.waiting?.approval_recorded_ms), detail: `${data.waiting?.approval_known_records ?? '未知'} 条有完整时间；可能与执行间隔重叠` },
    { label: '记忆注入 / 自报引用', value: `${data.memory?.injected_works ?? '未知'} / ${data.memory?.cited_works ?? '未知'}`, detail: '有记录的任务数；有效复用未知' },
    { label: '注入 token 估算', value: data.memory?.injection_estimated_token_count ?? '未知', detail: '字符估算，仅含有数值的记录，不是账单 token' },
    { label: '复盘已知成本小计', value: reflection?.known_cost_usd == null ? '未知' : `USD ${reflection.known_cost_usd.toFixed(4)}`, detail: `${reflection?.cost_known_attempts ?? '未知'}/${reflection?.recorded_attempts ?? '未知'} 条有金额；${reflection?.partial_attempts ?? '未知'} 条部分回执；SDK 估算` },
    { label: 'Supervisor 总成本', value: '未知', detail: '当前仅覆盖已记录复盘，其余开销尚未覆盖' },
  ];
}
