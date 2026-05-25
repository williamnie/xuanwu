const HOLD_TEXT_LIMIT = 120;

export function holdReasonLabel(reason = '') {
  switch (reason) {
    case 'usage_limit':
      return '用量/限额';
    case 'authentication':
      return '认证失败';
    default:
      return reason || '未知原因';
  }
}

export function normalizeHoldText(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

export function splitHoldText(value = '', limit = HOLD_TEXT_LIMIT) {
  const full = String(value || '').trim();
  const summary = normalizeHoldText(full);
  if (summary.length <= limit && !full.includes('\n')) {
    return { summary, full, collapsed: false };
  }
  return {
    summary: `${summary.slice(0, limit).trim()}…`,
    full,
    collapsed: true,
  };
}
