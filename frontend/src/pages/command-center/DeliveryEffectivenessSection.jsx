import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { projectsApi } from '../../api/projects.js';
import { getDeliveryEffectiveness } from '../../api/deliveryEffectiveness.js';
import { effectivenessFacts, overheadFacts, metricMinutes, metricMoney, deliveryRange } from './deliveryEffectivenessModel.js';
import './DeliveryEffectivenessSection.css';

const TYPE_LABELS = { engineering_task: '工程任务', objective: '目标' };
export default function DeliveryEffectivenessSection() {
  const [snapshot, setSnapshot] = useState(null);
  const [projects, setProjects] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [filters, setFilters] = useState(() => ({ project_id: '', task_type: '', ...deliveryRange(30), limit: 25 }));
  const [history, setHistory] = useState([]);
  useEffect(() => {
    let active = true;
    projectsApi.getProjects().then(result => { if (active) setProjects(Array.isArray(result) ? result : result.projects || []); })
      .catch(() => { /* 统计仍可读取；项目选择保留全部项目。 */ });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setSnapshot(null); setError('');
    getDeliveryEffectiveness(filters, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setSnapshot(data);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure.message || '统计暂不可用');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filters, revision]);
  function changeFilters(patch) { setLoading(true); setSnapshot(null); setHistory([]); setFilters(value => ({ ...value, ...patch, before_issue_id: undefined })); }
  function nextPage() {
    setLoading(true); setSnapshot(null);
    setHistory(value => [...value, filters.before_issue_id]);
    setFilters(value => ({ ...value, before_issue_id: snapshot.next_before_issue_id }));
  }
  function previousPage() {
    setLoading(true); setSnapshot(null);
    setFilters(value => ({ ...value, before_issue_id: history.at(-1) }));
    setHistory(value => value.slice(0, -1));
  }
  return <section className="delivery-effectiveness" aria-label="交付效果与记忆开销" aria-busy={loading}>
    <header><div><span>DELIVERY OUTCOMES</span><h3>交付效果与记忆开销</h3></div>
      <button className="btn btn-secondary" disabled={loading} onClick={() => setRevision(value => value + 1)} type="button">
        <RefreshCw className={loading ? 'spin-animation' : ''} size={14} /> 刷新统计
      </button>
    </header>
    <form className="delivery-filters" onSubmit={event => event.preventDefault()}>
      <label>项目<select value={filters.project_id} onChange={event => changeFilters({ project_id: event.target.value })}>
        <option value="">全部项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label>
      <label>任务类型<select value={filters.task_type} onChange={event => changeFilters({ task_type: event.target.value })}>
        <option value="">全部类型</option>{Object.entries(TYPE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <label>开始日期（UTC）<input type="date" value={filters.from.slice(0, 10)} onChange={event => { if (event.target.value) changeFilters({ from: `${event.target.value}T00:00:00.000Z` }); }} /></label>
      <label>结束日期（UTC）<input type="date" value={filters.to.slice(0, 10)} onChange={event => { if (event.target.value) changeFilters({ to: `${event.target.value}T23:59:59.999Z` }); }} /></label>
    </form>
    {error ? <p role="alert">{error}</p> : null}
    {snapshot ? <>
      <p>{snapshot.since.slice(0, 10)} 至 {snapshot.until.slice(0, 10)}（UTC）· 本页 {snapshot.sampled_works} 个结束任务 · {snapshot.completed_works} 个完成</p>
      <p>以下汇总、分组与趋势仅覆盖本页样本。{snapshot.has_more ? '尚有候选记录，请继续翻页；空页也可继续。' : '已到候选记录末页。'} 不同项目或日期的比较需使用相同范围并核对覆盖率。</p>
      <dl>{[...effectivenessFacts(snapshot), ...overheadFacts(snapshot)].map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd><small>{fact.detail}</small></div>)}</dl>
      <GroupTable title="按项目" rows={snapshot.by_project} label={key => projects.find(p => p.id === key)?.name || key} />
      <GroupTable title="按任务类型" rows={snapshot.by_type} label={key => TYPE_LABELS[key] || key} />
      <GroupTable title="按结束日期（UTC）" rows={snapshot.trend} />
      <details><summary>查看本页样本与审计引用</summary>
        {snapshot.samples.length ? snapshot.samples.map(sample => <details className="delivery-sample" key={sample.work_id}>
          <summary>{sample.work_id} · {sample.project_id} · {sample.delivered ? '可验收交付' : '交付未确认'} · {sample.limited_sources.length ? '部分数据' : '已读取有界来源'}</summary>
          <p>{sample.status} · {sample.ended_at} · {sample.run_count ?? '未知'} 次执行 · {sample.asked_for_help === null ? '求助记录读取受限' : sample.asked_for_help ? '有求助记录' : '无求助记录，人工介入未知'}</p>
          <p>执行间隔 {metricMinutes(sample.waiting.run_gap_ms)} · 审批记录时长 {metricMinutes(sample.waiting.approval_recorded_ms)} · 执行金额 {metricMoney(sample.cost)}</p>
          <p>记忆注入 {sample.memory.injected ? '有记录' : '无有效记录'} · 自报引用 {sample.memory.cited ? '有记录' : '无有效记录'} · 有效复用未知</p>
          <p>Run：{sample.run_ids.join('、')}<br />Handoff：{sample.handoff_id || '未知'}<br />Evidence：{sample.evidence_ids.join('、') || '未知'}</p>
          <p>审计引用：{sample.audit_refs.join('、') || '无记录'}</p>
          {sample.limited_sources.length ? <p>数据限制：{sample.limited_sources.join('、')}</p> : null}
        </details>) : <p>本页没有符合条件的样本。</p>}
      </details>
      <div className="delivery-pagination">
        <button type="button" className="btn btn-secondary" disabled={loading || !history.length} onClick={previousPage}>上一页</button>
        <span>第 {history.length + 1} 页</span>
        <button type="button" className="btn btn-secondary" disabled={loading || !snapshot.has_more} onClick={nextPage}>下一页</button>
      </div>
      <details><summary>统计口径与数据覆盖</summary>
        <p>类型来自既有 Work 类型，Issue 默认归为工程任务。任务状态与审计是当前持久化事实，日期按最新 Run 结束时间筛选；不是历史时点快照。</p>
        <p>“无求助记录”仅指没有审批请求或需用户处理的通知，不代表没有人工操作。执行间隔与审批时长可能重叠，不相加为总等待，不推算节省时长。</p>
        <p>执行成本要求每次执行都有金额；缺失、读取受限或同任务币种冲突均为未知。币种分别统计。复盘成本是 SDK 估算的已知小计，可能只有部分回执；Supervisor 总成本仍未知。</p>
        <p>注入仅证明输入已构造，引用仅是执行器自报；有效复用尚无归因证据，单次任务成功不能证明记忆收益。注入 token 是字符估算，不是账单。</p>
        <p>本页 {snapshot.data_coverage.limited_works} 个任务读取受限；交付可检查 {snapshot.data_coverage.delivery_known_works}/{snapshot.sampled_works}；执行成本已知 {snapshot.cost.known_works}/{snapshot.completed_works}；记忆有审计 {snapshot.memory.audit_covered_works}/{snapshot.sampled_works}。缺失的记录保持未知。</p>
        <p>更新于 {new Date(snapshot.generated_at).toLocaleString()} · 每页最多 {snapshot.sample_limit} 个样本 · 日期范围最多 90 天。</p>
      </details>
    </> : !error ? <p>{loading ? '正在读取交付统计…' : '暂无统计'}</p> : null}
  </section>;
}

function GroupTable({ title, rows = [], label = key => key }) {
  return <div className="delivery-table-scroll"><table><caption>{title} · 本页样本</caption>
    <thead><tr><th scope="col">分组</th><th scope="col">交付 / 样本</th><th scope="col">重复执行</th><th scope="col">求助记录</th><th scope="col">执行间隔</th><th scope="col">执行确认成本</th><th scope="col">复盘已知小计</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.key}><th scope="row">{label(row.key)}</th><td>{row.delivered_works} / {row.sampled_works}</td><td>{row.recovery.repeated_run_works}</td><td>{row.help_requested_works}</td><td>{metricMinutes(row.waiting.run_gap_ms)}</td><td>{row.execution_cost.by_currency.length ? row.execution_cost.by_currency.map(c => `${c.currency} ${(c.amount_micros / 1e6).toFixed(4)}`).join(' / ') : '未知'}（{row.execution_cost.known_works}/{row.sampled_works}）</td><td>{row.supervisor.reflection.known_cost_usd == null ? '未知' : `USD ${row.supervisor.reflection.known_cost_usd.toFixed(4)}`}</td></tr>)}</tbody>
  </table></div>;
}
