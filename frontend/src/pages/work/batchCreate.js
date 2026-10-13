// 只有代码围栏外独占一行的 --- 才分隔任务；段落和代码换行原样保留。
export function previewBatch(text, auditFactory) {
  const goals = [];
  let lines = [];
  let fence = null;
  for (const line of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    }
    if (!fence && /^\s*---\s*$/.test(line)) {
      goals.push(lines.join('\n').trim());
      lines = [];
    } else lines.push(line);
  }
  goals.push(lines.join('\n').trim());
  return goals.filter(Boolean).map(goal => ({ goal, audit: auditFactory(), status: 'ready', error: '', work: null }));
}

export async function createBatchRow(row, payload, api) {
  try {
    const result = await api.createWork({ ...payload, goal: row.goal, audit: row.audit });
    if (!result?.work?.id) return { ...row, status: 'unknown', error: '响应缺少任务 ID，请核对结果' };
    return { ...row, status: 'created', work: result.work, error: '' };
  } catch (error) {
    // 网络/服务端错误可能发生在事务提交后；409 也可能是同审计 ID 的不同载荷。
    const definitive = error.status >= 400 && error.status < 500 && ![408, 409, 429].includes(error.status);
    return { ...row, status: definitive ? 'failed' : 'unknown', error: error.message || '创建失败' };
  }
}

export async function reconcileBatchRow(row, api) {
  try {
    const result = await api.getCreationResult(row.audit.event_id);
    if (result?.status === 'created' && result.work?.id) return { ...row, status: 'created', work: result.work, error: '' };
    if (result?.status === 'not_found') return { ...row, status: 'failed', error: '尚未查到已创建任务；可使用同一审计 ID 重试' };
    return { ...row, status: 'unknown', error: '核对结果不完整' };
  } catch (error) { return { ...row, status: 'unknown', error: error.message || '核对失败' }; }
}
