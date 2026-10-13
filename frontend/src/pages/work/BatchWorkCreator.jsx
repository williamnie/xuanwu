import { useState } from 'react';
import { workApi } from '../../api/work.js';
import { previewBatch, createBatchRow, reconcileBatchRow } from './batchCreate.js';

export default function BatchWorkCreator({ payload, auditFactory, canSubmit, onDone, onBusy }) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [confirmedPayload, setConfirmedPayload] = useState(null);
  const labels = { ready: '待创建', created: '已创建', failed: '失败', unknown: '结果未知' };
  const run = async (indices, reconcile = false) => {
    setBusy(true); onBusy(true);
    // 首次提交后锁定配置；重试使用原始载荷与原审计 ID。
    const fixed = confirmedPayload || { ...payload };
    setConfirmedPayload(fixed);
    try {
      for (const index of indices) {
        const next = reconcile ? await reconcileBatchRow(rows[index], workApi) : await createBatchRow(rows[index], fixed, workApi);
        setRows(current => current.map((row, position) => position === index ? next : row));
      }
    } finally { setBusy(false); onBusy(false); }
  };
  return <div className="batch-work-creator">
    {!rows.length ? <>
      <label><span>批量任务内容</span><textarea className="form-control" rows={8} value={text} onChange={event => setText(event.target.value)} placeholder="每个任务可以有多个段落。用独占一行的 --- 分隔任务；代码块中的分隔线不会拆分。" /></label>
      <button className="btn btn-secondary" type="button" disabled={!text.trim()} onClick={() => setRows(previewBatch(text, auditFactory))}>预览拆分</button>
    </> : <>
      <p>{confirmedPayload ? `已提交配置：项目 ${confirmedPayload.project_id} · ${confirmedPayload.status === "todo" ? "加入执行队列" : "待确认"}。` : ""}共 {rows.length} 条。核对内容和项目后再创建；成功项不会重复提交。</p>
      {rows.map((row, index) => <div className="batch-work-row" key={row.audit.event_id}>
        <strong>任务 {index + 1} · {labels[row.status]}</strong>
        <textarea aria-label={`任务 ${index + 1} 内容`} className="form-control" rows={4} value={row.goal} disabled={busy || Boolean(confirmedPayload)} onChange={event => setRows(current => current.map((item, position) => position === index ? { ...item, goal: event.target.value } : item))}/>
        {row.error && <p role="alert">{row.error}</p>}
        {row.work && <a href={`#/tasks?workId=${encodeURIComponent(row.work.id)}`}>查看任务</a>}
        {row.status === 'unknown' && <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => run([index], true)}>核对创建结果</button>}
      </div>)}
      <div className="batch-work-actions">
        {!confirmedPayload && <button className="btn btn-secondary" type="button" onClick={() => setRows([])}>返回编辑</button>}
        <button className="btn btn-primary" type="button" disabled={busy || !canSubmit || !rows.some(row => ['ready', 'failed'].includes(row.status) && row.goal.trim())} onClick={() => run(rows.flatMap((row, index) => ['ready', 'failed'].includes(row.status) && row.goal.trim() ? [index] : []))}>{busy ? '处理中…' : confirmedPayload ? '只重试失败项' : '确认创建'}</button>
        <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => onDone(rows.filter(row => row.status === 'created').map(row => row.work))}>完成</button>
      </div>
    </>}
  </div>;
}
