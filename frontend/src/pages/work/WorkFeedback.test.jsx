import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import WorkFeedback from './WorkFeedback.jsx';

const feedback = { feedback: '请补充边界测试', question: '是否接受当前结果？', review_request_id: 'review:977', review_revision: 2, received_at: '2026-09-29', run: { id: 'issue-977-attempt-2', attempt: 2, status: 'running', provider_session_id: 'original-session', provider_turn_id: 'next-turn' } };
test('feedback shows its original request, version, exact text and continuation refs', () => {
  const html = renderToStaticMarkup(<WorkFeedback feedback={{ ...feedback, status: 'executing' }} />);
  for (const text of ['执行中', '是否接受当前结果？', '请补充边界测试', 'review:977', 'v2', 'issue-977-attempt-2', 'original-session', 'next-turn', '原 IM 对话']) expect(html).toContain(text);
});
test('feedback distinguishes receipt, completion, missing input, failure and cancellation', () => {
  for (const [status, label] of [['received', '已收到'], ['completed', '不代表已上线'], ['needs_input', '需补充'], ['failed', '处理失败'], ['cancelled', '已取消']]) {
    const html = renderToStaticMarkup(<WorkFeedback feedback={{ ...feedback, run: null, status, next_question: '请提供环境', error: status === 'failed' ? 'resume unavailable' : '' }} />);
    expect(html).toContain(label);
    expect(html).toContain('尚未记录反馈后的新 Run');
    expect(html).toContain('请提供环境');
    if (status === 'failed') expect(html).toContain('role="alert"');
  }
  expect(renderToStaticMarkup(<WorkFeedback feedback={null} />)).toBe('');
});
