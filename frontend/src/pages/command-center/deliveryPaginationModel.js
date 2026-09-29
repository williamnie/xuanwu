export function createDeliveryPageState(filters) {
  return { filters, history: [], snapshot: null, loading: true, error: '', failedRequest: null,
    request: { id: 1, filters, history: [] } };
}

// 筛选、页码和数据一起提交，读取失败时仍能正确解释屏幕上的旧数据。
export function deliveryPageReducer(state, action) {
  if (action.type === 'success' || action.type === 'failure') {
    if (action.id !== state.request.id) return state;
    if (action.type === 'failure') return { ...state, loading: false, error: action.error, failedRequest: state.request };
    return { ...state, snapshot: action.snapshot, filters: state.request.filters, history: state.request.history,
      loading: false, error: '', failedRequest: null };
  }
  if (state.loading) return state;
  let filters = state.filters;
  let history = state.history;
  switch (action.type) {
    case 'filters': filters = { ...filters, ...action.patch, before_issue_id: undefined }; history = []; break;
    case 'next':
      if (!state.snapshot?.has_more || state.snapshot.next_before_issue_id == null) return state;
      filters = { ...filters, before_issue_id: state.snapshot.next_before_issue_id };
      history = [...history, state.filters.before_issue_id];
      break;
    case 'previous':
      if (!history.length) return state;
      filters = { ...filters, before_issue_id: history.at(-1) };
      history = history.slice(0, -1);
      break;
    case 'retry':
      filters = state.failedRequest?.filters || filters;
      history = state.failedRequest?.history || history;
      break;
    case 'refresh': break;
    default: return state;
  }
  return { ...state, loading: true, error: '', failedRequest: null,
    request: { id: state.request.id + 1, filters, history } };
}
