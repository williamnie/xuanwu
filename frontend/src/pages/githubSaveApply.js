// “保存并生效”合成一个按钮，但保留保存与生效两个阶段（方案 6.4 ③ GitHub）：
// 先保存，再用保存返回的 revision 调用应用；失败时按错误类型分别处理，不用重新读到的新 revision 自动重试。
export function classifyApplyError(error) {
  const text = String(error?.message || '');
  if (error?.status === 409 && text.startsWith('config_conflict')) return 'config_conflict';
  if (error?.status === 409 && text.startsWith('reload_failed')) return 'reload_failed';
  if (error?.status === 503 || text.startsWith('runtime_unavailable')) return 'runtime_unavailable';
  if (!error?.status) return 'unconfirmed';
  return 'failed';
}

// 网络超时等无法确认结果时：读取当前保存版本与生效状态，确认是不是自己的版本再决定。
export function resolveUncertainApply(remote, savedRevision) {
  if (!remote || remote.revision !== savedRevision) return 'config_conflict';
  return remote.application?.status === 'applied' ? 'applied' : 'unconfirmed';
}

export const APPLY_PENDING_COPY = {
  reload_failed: '已保存，待生效：轮询正在运行，现有规则保持不变。可以稍后“重试生效”。',
  runtime_unavailable: '已保存，待服务恢复后生效。',
  unconfirmed: '已保存，但未能确认是否生效。可以“重试生效”。',
};

// 只有保存的版本仍是当前版本、且草稿没有新修改时，才允许单独重试生效。
export function canRetryApply(state, dirty) {
  return Boolean(state.remote && state.savedRevision && !dirty && !state.conflict
    && state.remote.revision === state.savedRevision
    && state.remote.application?.status !== 'applied');
}
