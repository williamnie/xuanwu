// 卡片类型由后端请求决定：只有 decision.owner === 'human' 且请求仍打开时才给回复按钮；
// 任务虽是 needs_user 但仍由玄武助手持有时，只显示“玄武正在整理问题”。
// key 用“来源类型 + 原始请求 ref”，同一任务的多个请求不会被合并。
export function taskRequestCards({ decisions = new Map(), failed = [], needsUser = [] } = {}) {
  const cards = [];
  for (const work of needsUser) {
    const decision = decisions.get(work.id) || null;
    const request = decision?.owner === 'human' && decision?.request?.status === 'open' ? decision.request : null;
    if (request) {
      cards.push({ key: `review:${request.id}`, kind: 'review', request, work });
    } else {
      cards.push({
        detail: decisions.has(work.id) ? '玄武正在整理需要你确认的问题，整理好后会出现在这里。' : '暂时读不到请求详情，打开任务查看。',
        key: `pending:${work.id}`,
        kind: 'preparing',
        label: 'PREPARING',
        tone: 'idle',
        work,
      });
    }
  }
  for (const work of failed) {
    cards.push({
      detail: '执行没有成功。可以重试，或打开任务查看每次执行的过程。',
      key: `failed:${work.id}:${work.revision ?? ''}`,
      kind: 'failed',
      label: 'FAILED',
      tone: 'error',
      work,
    });
  }
  return cards;
}
