export const GITHUB_OPERATIONS = [
  ['autoEnqueue', '自动排队调查'], ['allowFix', '允许修复'],
  ['allowPullRequest', '允许创建 PR'], ['closeOnMerge', '合并并通过 CI 后关单'],
];
export const githubPhaseLabel = value => ({ intake: '已接收', investigate: '调查', repair: '修复', needs_user: '求助 · 等待回答', review: 'PR · 等待评审', resolved: '已交付', paused: '暂停' })[value] || value || '未知';
export const githubConnectionLabel = value => ({
  connected: '连接正常，仓库和标签可读取', permission_denied: '权限不足，请检查仓库访问及所选操作权限',
  authentication_failed: '认证失败，请检查现有凭据', credential_unavailable: '凭据不可用，请检查引用或本机认证',
  repository_unavailable: '仓库不存在或当前凭据无权查看', label_mismatch: '标签不匹配，未找到完全一致的接管标签',
  temporarily_unavailable: '暂时不可用或限流，请稍后重试', connection_failed: '连接失败，请检查网络及 API 配置',
})[value] || value || '尚未测试';
export const githubApplicationLabel = value => ({ applied: '已生效', pending: '已保存 · 未生效', unavailable: '运行时不可用 · 待启动或重启' })[value] || '状态未知';
export const githubIntakeLabel = value => ({ matched: '标签匹配', label_mismatch: '标签不匹配 · 停止接管', closed: 'GitHub 已关闭', mapping_conflict: '项目映射冲突', unknown: '标签状态未知' })[value] || value;
export function newGitHubRepository(projectId = '') {
  return { repository: '', projectId, intakeLabel: 'xuanwu', autoEnqueue: false, allowFix: false, allowPullRequest: false, closeOnMerge: false, baseBranch: '', ciFailureMode: 'repair', ciFailureReason: '' };
}
export function initialGitHubSettings() {
  return { remote: null, draft: null, revision: '', busy: false, operation: '', error: '', notice: '', testResult: null, conflict: false };
}
export function githubDraftDirty(state) { return Boolean(state.remote && JSON.stringify(state.draft) !== JSON.stringify(state.remote.settings)); }
export function githubSettingsReducer(state, action) {
  switch (action.type) {
    case 'start': return { ...state, busy: true, operation: action.operation, error: '', notice: '' };
    case 'loaded': {
      const preserve = githubDraftDirty(state);
      return { ...state, busy: false, remote: action.remote,
        draft: preserve ? state.draft : structuredClone(action.remote.settings), revision: preserve ? state.revision : action.remote.revision,
        conflict: preserve && state.revision !== action.remote.revision, notice: preserve ? '状态已刷新，本地草稿已保留。' : '' };
    }
    case 'edit': return { ...state, draft: action.draft, error: '', notice: '', testResult: null };
    case 'saved': return { ...state, busy: false, remote: action.remote, draft: structuredClone(action.remote.settings), revision: action.remote.revision, conflict: false, notice: '配置已保存，请核对生效状态。' };
    case 'applied': return { ...state, busy: false, remote: action.remote, notice: '已应用保存版本，后续轮询使用新规则。' };
    case 'tested': return { ...state, busy: false, testResult: action.result };
    case 'error': return { ...state, busy: false, error: action.message, conflict: state.conflict || action.status === 409 };
    case 'use-server': return { ...state, draft: structuredClone(state.remote.settings), revision: state.remote.revision, conflict: false, error: '', testResult: null };
    case 'rebase': return { ...state, revision: state.remote.revision, conflict: false, error: '', notice: '已采用最新版本号；请核对草稿后保存。' };
    default: return state;
  }
}
