export const JEV_SCOPES = [
  ['web', 'Web 对话'], ['github', 'GitHub'], ['feishu', '飞书'],
  ['telegram', 'Telegram'], ['background', '后台任务'],
];

export function jevDraft(settings = {}) {
  return {
    enabled: settings.enabled === true,
    mode: settings.mode === 'assist' ? 'assist' : 'shadow',
    model: settings.model || 'jev-latest',
    scopes: Array.isArray(settings.scopes) ? [...settings.scopes] : [],
    min_confidence: settings.min_confidence ?? 0.9,
    timeout_ms: settings.timeout_ms ?? 5000,
    api_key: '',
    clear_api_key: false,
  };
}

export function initialJevState() {
  return {
    remote: null, draft: jevDraft(), dirty: {}, revisions: {}, revision: 0,
    loading: true, saving: false, testing: false, error: '', notice: '',
    testResult: null, testStale: false,
  };
}

export function jevSettingsReducer(state, action) {
  switch (action.type) {
    case 'load-start': return { ...state, loading: true, error: '' };
    case 'loaded': return applyRemote(state, action.settings);
    case 'load-error': return { ...state, loading: false, error: action.error };
    case 'edit': return editDraft(state, action.patch);
    case 'save-start': return { ...state, saving: true, error: '', notice: '' };
    case 'saved': return {
      ...applyRemote(state, action.settings, action.revisions), saving: false,
      notice: '配置已保存，后续调用使用新配置。',
    };
    case 'save-error': return { ...state, saving: false, error: action.error };
    case 'test-start': return { ...state, testing: true, error: '', testResult: null, testStale: false };
    case 'tested': return {
      ...state, testing: false, testResult: action.result,
      testStale: state.revision !== action.revision,
    };
    case 'test-error': return { ...state, testing: false, error: action.error };
    default: return state;
  }
}

function applyRemote(state, settings, submittedRevisions) {
  const next = jevDraft(settings);
  const dirty = { ...state.dirty };
  const draft = { ...state.draft };
  for (const field of Object.keys(next)) {
    // 刷新保留未保存的字段；保存只接纳提交后未再编辑的字段。
    const accept = submittedRevisions
      ? (state.revisions[field] || 0) === (submittedRevisions[field] || 0)
      : !dirty[field];
    if (accept) {
      draft[field] = next[field];
      delete dirty[field];
    }
  }
  return { ...state, remote: settings, draft, dirty, loading: false, error: '' };
}

function editDraft(state, patch) {
  const revision = state.revision + 1;
  const edits = { ...patch };
  if (edits.clear_api_key === true) edits.api_key = '';
  if (typeof edits.api_key === 'string' && edits.api_key.length) edits.clear_api_key = false;
  const revisions = { ...state.revisions };
  const dirty = { ...state.dirty };
  for (const field of Object.keys(edits)) {
    revisions[field] = revision;
    dirty[field] = true;
  }
  return {
    ...state, draft: { ...state.draft, ...edits }, revisions, dirty, revision,
    notice: '', testStale: Boolean(state.testResult),
  };
}

export function jevPayload(draft) {
  return {
    enabled: draft.enabled, mode: draft.mode, model: draft.model.trim(),
    scopes: [...draft.scopes], min_confidence: Number(draft.min_confidence),
    timeout_ms: Number(draft.timeout_ms),
    ...(draft.clear_api_key ? { clear_api_key: true } : draft.api_key.trim() ? { api_key: draft.api_key.trim() } : {}),
  };
}

export function jevDraftError(draft) {
  if (!/^jev-[a-z0-9.-]{1,80}$/.test(draft.model.trim())) return '请填写有效的 Jev 模型名称。';
  if (draft.min_confidence === '' || !Number.isFinite(Number(draft.min_confidence)) || Number(draft.min_confidence) < 0.5 || Number(draft.min_confidence) > 1) return '最低置信度需要在 0.5 到 1 之间。';
  if (draft.timeout_ms === '' || !Number.isInteger(Number(draft.timeout_ms)) || Number(draft.timeout_ms) < 500 || Number(draft.timeout_ms) > 30000) return '超时需要填写 500 到 30000 之间的整数毫秒数。';
  return '';
}

export function jevAvailabilityLabel(status) {
  return {
    ready: '已配置', disabled: '已停用', unconfigured: '未配置 Key', missing: '技能包缺失',
    invalid: '配置无效', cooldown: '故障冷却中',
  }[status] || status || '等待状态';
}
