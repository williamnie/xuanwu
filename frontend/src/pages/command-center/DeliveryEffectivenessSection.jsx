import { useEffect, useReducer, useState } from 'react';
import { BarChart3, RefreshCw } from 'lucide-react';
import { projectsApi } from '../../api/projects.js';
import { getDeliveryEffectiveness } from '../../api/deliveryEffectiveness.js';
import { effectivenessFacts, costFacts, recoveryFacts, overheadFacts, currencySubtotal, metricMinutes, metricMoney, deliveryRange } from './deliveryEffectivenessModel.js';
import { createDeliveryPageState, deliveryPageReducer } from './deliveryPaginationModel.js';
import './DeliveryEffectivenessSection.css';

const TYPE_LABELS = { engineering_task: '工程任务', objective: '目标' };
const GROUP_LABELS = { by_project: '按项目', by_type: '按任务类型', trend: '按结束日期（UTC）' };
export default function DeliveryEffectivenessSection() {
  const [state, dispatch] = useReducer(deliveryPageReducer, null, () => createDeliveryPageState({
    project_id: '', task_type: '', ...deliveryRange(30), limit: 25,
  }));
  const { snapshot, filters, request, history, error, loading } = state;
  const [projects, setProjects] = useState([]);
  const [grouping, setGrouping] = useState('by_project');
  const shownFilters = loading ? request.filters : filters;
  useEffect(() => {
    let active = true;
    projectsApi.getProjects().then(result => { if (active) setProjects(Array.isArray(result) ? result : result.projects || []); })
      .catch(() => { /* 统计仍可读取；项目选择保留全部项目。 */ });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    getDeliveryEffectiveness(request.filters, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) dispatch({ type: 'success', id: request.id, snapshot: data });
    }).catch(failure => {
      if (!controller.signal.aborted) dispatch({ type: 'failure', id: request.id, error: failure.message || '统计暂不可用' });
    });
    return () => controller.abort();
  }, [request]);
  const changeFilters = patch => dispatch({ type: 'filters', patch });
  const groupLabel = key => grouping === 'by_project' ? projects.find(project => project.id === key)?.name || key
    : grouping === 'by_type' ? TYPE_LABELS[key] || key : key;
  return <section className="delivery-effectiveness" aria-label="交付统计">
    <header className="delivery-heading">
      <div><span className="delivery-eyebrow">DELIVERY REPORT</span><h2>任务交付统计</h2><p>查看任务是否交付、哪里需要协助，以及已记录的执行费用。</p></div>
      <button className="btn btn-secondary" disabled={loading} onClick={() => dispatch({ type: error ? 'retry' : 'refresh' })} type="button">
        <RefreshCw className={loading ? 'spin-animation' : ''} size={14} aria-hidden="true" /> {error ? '重试查询' : '刷新统计'}
      </button>
    </header>
    <form className="delivery-filters" onSubmit={event => event.preventDefault()}>
      <label>项目<select disabled={loading} value={shownFilters.project_id} onChange={event => changeFilters({ project_id: event.target.value })}>
        <option value="">全部项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label>
      <label>任务类型<select disabled={loading} value={shownFilters.task_type} onChange={event => changeFilters({ task_type: event.target.value })}>
        <option value="">全部类型</option>{Object.entries(TYPE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <label>开始日期（UTC）<input disabled={loading} type="date" max={shownFilters.to.slice(0, 10)} value={shownFilters.from.slice(0, 10)} onChange={event => { if (event.target.value) changeFilters({ from: `${event.target.value}T00:00:00.000Z` }); }} /></label>
      <label>结束日期（UTC）<input disabled={loading} type="date" min={shownFilters.from.slice(0, 10)} value={shownFilters.to.slice(0, 10)} onChange={event => { if (event.target.value) changeFilters({ to: `${event.target.value}T23:59:59.999Z` }); }} /></label>
    </form>
    <div className="delivery-page-toolbar">
      <p>{snapshot ? <>当前显示第 {history.length + 1} 页 · {snapshot.sampled_works} 个结束任务</> : '每页最多 25 个结束任务'}</p>
      <nav className="delivery-pagination" aria-label="统计分页">
        <button type="button" className="btn btn-secondary" disabled={loading || !history.length} onClick={() => dispatch({ type: 'previous' })}>上一页</button>
        <span>第 {history.length + 1} 页</span>
        <button type="button" className="btn btn-secondary" disabled={loading || !snapshot?.has_more} onClick={() => dispatch({ type: 'next' })}>下一页</button>
      </nav>
    </div>
    <div className="delivery-query-status" role={error ? 'alert' : 'status'}>
      {error ? <span className="delivery-query-error">查询失败：{error}。{snapshot ? `仍显示上次成功查询的第 ${history.length + 1} 页，筛选条件已还原。` : '请重试查询。'}</span>
        : loading ? snapshot ? `正在读取新结果，暂时保留第 ${history.length + 1} 页的数据…` : '正在读取交付统计…'
          : snapshot ? '本页统计不会跨页累加；查看其他任务请翻页。' : null}
    </div>
    <div className="delivery-results" aria-busy={loading}>
      {snapshot ? <>
        <div className="delivery-scope-note">
          <span className="delivery-eyebrow">CURRENT PAGE</span>
          <p>{snapshot.since.slice(0, 10)} 至 {snapshot.until.slice(0, 10)}（UTC） · {projects.find(project => project.id === filters.project_id)?.name || filters.project_id || '全部项目'} · {TYPE_LABELS[filters.task_type] || '全部类型'}</p>
          <p>以下数字仅覆盖本页，不代表整个日期范围。{snapshot.has_more ? '还有候选记录可继续翻页，空页也可能有下一页。' : '已到候选记录末页。'}</p>
        </div>
        <FactList facts={effectivenessFacts(snapshot)} className="delivery-overview-facts" />
        <section className="delivery-group-section" aria-labelledby="delivery-groups-title">
          <div className="delivery-section-heading"><div><h3 id="delivery-groups-title">看看哪些任务需要关注</h3><p>验证通过、重复执行和求助记录，均按当前页任务汇总。</p></div>
            <label className="delivery-group-picker">分组方式<select value={grouping} onChange={event => setGrouping(event.target.value)}>{Object.entries(GROUP_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          </div>
          <GroupTable title={GROUP_LABELS[grouping]} rows={snapshot[grouping]} label={groupLabel} />
        </section>
        <section className="delivery-cost-section" aria-labelledby="delivery-cost-title">
          <div className="delivery-section-heading"><div><h3 id="delivery-cost-title">费用记录</h3><p>只统计有完整金额记录的任务；不同币种分别展示，缺失金额保留为“未知”。</p></div></div>
          <FactList facts={costFacts(snapshot)} className="delivery-cost-facts" />
        </section>
        <details className="delivery-disclosure"><summary>高级诊断：恢复、等待与记忆</summary>
          <p>用于排查执行效率。记忆注入表示准备过输入，引用表示执行器自报，均不能证明记忆被有效复用。</p>
          <FactList facts={[...recoveryFacts(snapshot), ...overheadFacts(snapshot)]} />
        </details>
        <details className="delivery-disclosure"><summary>任务明细与审计引用 · {snapshot.samples.length} 个</summary>
          <p>查看每个任务的运行、验证证据和数据缺失情况。</p>
          {snapshot.samples.length ? snapshot.samples.map(sample => <details className="delivery-sample" key={sample.work_id}>
            <summary>{sample.work_id} · {projects.find(project => project.id === sample.project_id)?.name || sample.project_id} · {sample.delivered ? '验证通过' : '交付未确认'} · {sample.limited_sources.length ? '部分数据' : '已读取有界来源'}</summary>
            <p>{sample.status} · {sample.ended_at} · {sample.run_count ?? '未知'} 次执行 · {sample.asked_for_help === null ? '求助记录读取受限' : sample.asked_for_help ? '有求助记录' : '无求助记录，人工介入未知'}</p>
            <p>执行间隔 {metricMinutes(sample.waiting.run_gap_ms)} · 审批记录时长 {metricMinutes(sample.waiting.approval_recorded_ms)} · 执行金额 {metricMoney(sample.cost)}</p>
            <p>记忆注入 {sample.memory.injected ? '有记录' : '无有效记录'} · 自报引用 {sample.memory.cited ? '有记录' : '无有效记录'} · 有效复用未知</p>
            <p>Run：{sample.run_ids.join('、')}<br />Handoff：{sample.handoff_id || '未知'}<br />Evidence：{sample.evidence_ids.join('、') || '未知'}</p>
            <p>审计引用：{sample.audit_refs.join('、') || '无记录'}</p>
            {sample.limited_sources.length ? <p>数据限制：{sample.limited_sources.join('、')}</p> : null}
          </details>) : <p>本页没有符合条件的样本。</p>}
        </details>
        <details className="delivery-disclosure"><summary>这些数字怎么算？</summary>
          <p>本页按任务编号倒序扫描，日期按最新 Run 结束时间筛选。这里展示当前持久化事实，不是历史时点快照。对比项目时，请使用相同日期范围并核对数据覆盖；跨页不会自动累计。</p>
          <p>“交付验证通过”表示任务已完成，对应最新执行的交付记录齐全、验证证据通过且必需交付动作成功，不代表人工验收或上线。“请求协助”指审批请求或需用户处理的通知；无求助记录不代表没有人工操作。</p>
          <p>执行间隔与审批时长可能重叠，不相加为总等待，不推算节省时长。执行金额要求每次执行都有金额；缺失、读取受限或同任务币种冲突均为未知。</p>
          <p>复盘金额是 SDK 估算的已知小计，可能只有部分回执；Supervisor 总成本仍未知。记忆注入 token 是字符估算，不是账单；单次任务成功不能证明记忆收益。</p>
          <p>本页 {snapshot.data_coverage.limited_works} 个任务读取受限；交付可检查 {snapshot.data_coverage.delivery_known_works}/{snapshot.sampled_works}；完成任务成本已知 {snapshot.cost.known_works}/{snapshot.completed_works}；记忆有审计 {snapshot.memory.audit_covered_works}/{snapshot.sampled_works}。缺失记录保持未知。</p>
          <p>更新于 {new Date(snapshot.generated_at).toLocaleString()} · 每页最多 {snapshot.sample_limit} 个样本 · 日期范围最多 90 天。</p>
        </details>
      </> : <div className="delivery-empty"><BarChart3 size={34} aria-hidden="true" /><p>{loading ? '正在准备本页数据…' : '统计暂不可用，请重试查询。'}</p></div>}
    </div>
  </section>;
}

function FactList({ facts, className = '' }) {
  return <dl className={`delivery-facts ${className}`}>{facts.map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd><small>{fact.detail}</small></div>)}</dl>;
}

function GroupTable({ title, rows = [], label = key => key }) {
  return <div className="delivery-table-scroll" tabIndex={0} role="region" aria-label={`${title}统计表，可滚动`}><table><caption>{title} · 本页样本</caption>
    <thead><tr><th scope="col">分组</th><th scope="col">验证通过 / 任务数</th><th scope="col">重复执行</th><th scope="col">请求协助</th><th scope="col">执行金额（已知）</th></tr></thead>
    <tbody>{rows.length ? rows.map(row => <tr key={row.key}><th scope="row">{label(row.key)}</th><td>{row.delivered_works} / {row.sampled_works}</td><td>{row.recovery.repeated_run_works}</td><td>{row.help_requested_works}</td><td>{currencySubtotal(row.execution_cost)}<small>{row.execution_cost.known_works}/{row.sampled_works} 个任务有金额</small></td></tr>)
      : <tr><td colSpan={5} className="delivery-table-empty">本页没有符合条件的任务。可以调整项目或日期范围。</td></tr>}</tbody>
  </table></div>;
}
