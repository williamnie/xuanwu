import { useI18n } from '../../i18n/context.js';
import './WorkFeedback.css';

export default function WorkFeedback({ feedback }) {
  const { language } = useI18n();
  const english = language === 'en-US';
  if (!feedback) return null;
  const labels = english
    ? { received: 'Received · awaiting PI processing', executing: 'In progress', completed: 'Completed · does not imply deployed', needs_input: 'More input needed', failed: 'Processing failed · awaiting PI', cancelled: 'Cancelled' }
    : { received: '已收到 · 等待 PI 处理', executing: '执行中', completed: '完成 · 不代表已上线', needs_input: '需补充', failed: '处理失败 · 等待 PI 处理', cancelled: '已取消' };
  return <section className="work-feedback" aria-label={english ? 'Feedback progress' : '反馈处理进度'}>
    <header><span>FEEDBACK</span><strong role="status" data-status={feedback.status}>{labels[feedback.status] || (english ? 'Unknown' : '状态未知')}</strong></header>
    <p><strong>{english ? 'Original question' : '原问题'}：</strong>{feedback.question}</p>
    <p><strong>{english ? 'Your response' : '你的反馈'}：</strong>{feedback.feedback || feedback.action}</p>
    {feedback.next_question ? <p><strong>{english ? 'Input needed' : '待补充问题'}：</strong>{feedback.next_question}</p> : null}
    {feedback.error ? <p role="alert">{feedback.error}</p> : null}
    <dl>
      <div><dt>REQUEST / VERSION</dt><dd>{feedback.review_request_id} · v{feedback.review_revision}</dd></div>
      <div><dt>RECEIVED</dt><dd>{feedback.received_at}</dd></div>
      <div><dt>RUN</dt><dd>{feedback.run ? `#${feedback.run.attempt} · ${feedback.run.id} · ${feedback.run.status}` : (english ? 'No new Run recorded' : '尚未记录反馈后的新 Run')}</dd></div>
      {feedback.run?.provider_session_id ? <div><dt>SESSION / TURN</dt><dd>{feedback.run.provider_session_id} / {feedback.run.provider_turn_id || '—'}</dd></div> : null}
      {feedback.origin_run_id ? <div><dt>ORIGIN RUN</dt><dd>{feedback.origin_run_id}</dd></div> : null}
    </dl>
    <p>{english ? 'Continue in the original IM conversation. This page shows the recorded feedback and current progress.' : '可继续在原 IM 对话反馈；本页可核对已记录的意见与当前进度。'}</p>
  </section>;
}
