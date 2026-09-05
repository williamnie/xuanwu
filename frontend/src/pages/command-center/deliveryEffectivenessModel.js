const percentage = value => typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : '—';

export function effectivenessFacts(data) {
  const money = data.cost?.by_currency || [];
  const time = data.duration?.median_ms;
  return [
    { label: '可验收交付率', value: percentage(data.delivery_rate), detail: `${data.delivered_works} / ${data.sampled_works} 个结束任务` },
    { label: '无求助记录的交付率', value: percentage(data.without_help_delivery_rate), detail: `${data.help_requested_works ?? '—'} 个任务有求助记录` },
    { label: '恢复后交付率', value: percentage(data.recovery?.delivery_rate), detail: `${data.recovery?.delivered_works || 0} / ${data.recovery?.works || 0} 个恢复任务` },
    { label: '多次恢复无进展', value: data.recovery?.repeated_no_progress_works ?? '—', detail: `累计 ${data.recovery?.no_progress_attempts || 0} 次无进展` },
    { label: '完成耗时中位数', value: typeof time === 'number' ? `${Math.round(time / 60000)} 分钟` : '—', detail: `${data.duration?.known_works || 0} 个完成任务有时间记录` },
    { label: '每个完成任务平均成本', value: money.length ? money.map(item => `${item.currency} ${(item.mean_micros / 1e6).toFixed(4)}`).join(' / ') : '未知', detail: `${data.cost?.known_works || 0} 个已知 · ${data.cost?.unknown_works || 0} 个未知` },
  ];
}
