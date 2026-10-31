// 共享展示层：不依赖页面，避免首页与执行页之间循环引用。
export const RUN_PHASE_META = {
  queued: { label: '排队中', tone: 'queued' },
  starting: { label: '启动中', tone: 'running' },
  running: { label: '执行中', tone: 'running' },
  waiting_approval: { label: '等待审批', tone: 'waiting' },
  recovering: { label: '恢复中', tone: 'recovering' },
  pi_deciding: { label: '玄武助手判断中', tone: 'verifying' },
  succeeded: { label: '已完成', tone: 'succeeded' },
  failed: { label: '失败', tone: 'failed' },
  cancelled: { label: '已取消', tone: 'cancelled' },
  interrupted: { label: '已中断', tone: 'waiting' },
  unknown: { label: '状态未知', tone: 'unknown' },
};

export function runPhaseLabel(phase) {
  return RUN_PHASE_META[phase]?.label || RUN_PHASE_META.unknown.label;
}
