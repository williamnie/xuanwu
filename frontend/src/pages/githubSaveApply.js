export function githubSettingsEqual(left, right) {
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key,stable(value[key])])) : value;
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}
export function githubErrorCode(error) {
  return error.code || /\b(config_conflict|reload_failed|runtime_unavailable)\b/.exec(error.message || '')?.[1] || (error.status == null ? 'uncertain' : 'request_failed');
}
export function githubOwnVersionApplied(remote, saved) {
  return Boolean(remote && saved && remote.revision === saved.revision && remote.application?.status === 'applied' && githubSettingsEqual(remote.application.active_settings,saved.settings));
}
// 保存响应是本次生效的唯一版本凭证；读取到其他窗口的新版本永远不自动应用。
export async function saveAndApplyGitHub({ api, revision, draft, savedSnapshot = null, retry = false, emit }) {
  let saved = retry ? savedSnapshot : null;
  try {
    if (!retry) {
      saved = await api.save(revision, draft);
      if (!saved?.revision || !saved?.settings) throw new Error('保存响应不完整，结果尚未确认');
      emit({ type: 'saved', remote: saved, keepBusy: true });
    }
    if (!saved?.revision) throw new Error('未确认本次保存版本，请先保存并核对');
    const applied = await api.reload(saved.revision);
    if (!githubOwnVersionApplied(applied, saved)) {
      emit({ type: 'apply-pending', remote: applied, saved, code: 'uncertain', message: '生效结果未确认，请刷新核对本次保存版本' });return;
    }
    emit({ type: 'applied', remote: applied });
  } catch (error) {
    const code = githubErrorCode(error);
    let remote = null;
    try { remote = await api.get(); } catch { /* 无读取证据时不允许把其他配置自动生效。 */ }
    if (saved && githubOwnVersionApplied(remote,saved)) { emit({ type: 'applied', remote });return; }
    if (code === 'config_conflict' || (saved && remote && remote.revision !== saved.revision)) {
      emit({ type: 'error', code: 'config_conflict', status: 409, message: '配置已变化，请重新核对；本地草稿已保留', remote });return;
    }
    if (saved && remote && remote.revision === saved.revision && githubSettingsEqual(remote.settings,saved.settings)) {
      const message = code === 'runtime_unavailable' ? '已保存，待服务恢复后生效' : code === 'reload_failed' ? '已保存，待生效；可重试本次保存版本' : '生效结果未确认；已核对保存版本，可重试生效';
      emit({ type: 'apply-pending', remote, saved, code, message });return;
    }
    emit({ type: 'error', code, status: error.status, message: saved ? '生效结果未确认，请刷新核对' : code === 'uncertain' ? '保存结果未确认，请核对当前配置后再保存' : error.message, remote, saved });
  }
}
