import { projectOptionLabel } from '../../utils/projectOptionLabel.js';
import { useProjectNodes } from '../../store/useProjectNodes.js';
import { useEffect, useState } from 'react';
import { BarChart3, RefreshCw } from 'lucide-react';
import { projectsApi } from '../../api/projects.js';
import { getDeliveryEffectiveness } from '../../api/deliveryEffectiveness.js';
import { RANGE_OPTIONS, effectivenessFacts, diagnosticFacts, currencySubtotal, deliveryRange } from './deliveryEffectivenessModel.js';
import './DeliveryEffectivenessSection.css';

export default function DeliveryEffectivenessSection() {
  const nodesById = useProjectNodes();
  const [days, setDays] = useState(30);
  const [projectId, setProjectId] = useState('');
  const [reload, setReload] = useState(0);
  const [projects, setProjects] = useState([]);
  const [state, setState] = useState({ data: null, loading: true, error: '' });
  const { data, loading, error } = state;
  useEffect(() => {
    let active = true;
    projectsApi.getProjects().then(result => { if (active) setProjects(Array.isArray(result) ? result : result.projects || []); })
      .catch(() => { /* 统计仍可读取；项目选择保留全部项目。 */ });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setState(previous => ({ ...previous, loading: true, error: '' }));
    getDeliveryEffectiveness({ scope: 'range', project_id: projectId, ...deliveryRange(days) }, { signal: controller.signal }).then(next => {
      if (!controller.signal.aborted) setState({ data: next, loading: false, error: '' });
    }).catch(failure => {
      if (!controller.signal.aborted) setState(previous => ({ ...previous, loading: false, error: failure.message || '统计暂不可用' }));
    });
    return () => controller.abort();
  }, [days, projectId, reload]);
  const projectName = key => projects.find(project => project.id === key)?.name || key;
  return <section className="delivery-effectiveness" aria-label="任务交付">
    <header className="delivery-toolbar">
      <nav className="delivery-range" aria-label="时间范围">
        {RANGE_OPTIONS.map(option => <button aria-pressed={days === option} key={option} onClick={() => setDays(option)} type="button">近 {option} 天</button>)}
      </nav>
      <select aria-label="项目" value={projectId} onChange={event => setProjectId(event.target.value)}>
        <option value="">全部项目</option>{projects.map(project => <option key={project.id} value={project.id}>{projectOptionLabel(project, nodesById, project.name)}</option>)}
      </select>
      <button className="btn btn-secondary" disabled={loading} onClick={() => setReload(value => value + 1)} type="button">
        <RefreshCw className={loading ? 'spin-animation' : ''} size={14} aria-hidden="true" /> 刷新
      </button>
    </header>
    {error ? <p className="delivery-query-error" role="alert">读取失败：{error}{data ? '，下面仍是上次的结果。' : ''}</p> : null}
    {data ? <div className="delivery-results" aria-busy={loading}>
      {data.truncated ? <p className="delivery-note">任务太多，只统计了最近的 {data.sample_limit} 个，可缩短时间范围或选择项目。</p> : null}
      <FactList facts={effectivenessFacts(data)} className="delivery-overview-facts" />
      {!projectId ? <ProjectTable rows={data.by_project} label={projectName} /> : null}
      <details className="delivery-disclosure"><summary>更多诊断数据</summary>
        <FactList facts={diagnosticFacts(data)} />
        <p className="delivery-note">“交付通过”指任务已完成、交付记录齐全且验证通过，不等于人工验收或上线。费用只统计每次执行都有金额记录的任务，不同币种分开显示。记录缺失时显示 “—”。</p>
      </details>
    </div> : <div className="delivery-empty"><BarChart3 size={34} aria-hidden="true" /><p>{loading ? '正在读取交付统计…' : '统计暂不可用，请刷新重试。'}</p></div>}
  </section>;
}

function FactList({ facts, className = '' }) {
  return <dl className={`delivery-facts ${className}`}>{facts.map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd><small>{fact.detail}</small></div>)}</dl>;
}

function ProjectTable({ rows = [], label }) {
  if (!rows.length) return <p className="delivery-note delivery-table-empty">这段时间没有结束的任务。</p>;
  return <div className="delivery-table-scroll" tabIndex={0} role="region" aria-label="按项目统计，可滚动"><table>
    <thead><tr><th scope="col">项目</th><th scope="col">结束任务</th><th scope="col">交付通过</th><th scope="col">请求协助</th><th scope="col">执行费用</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.key}><th scope="row">{label(row.key)}</th><td>{row.sampled_works}</td><td>{row.delivered_works}</td><td>{row.help_requested_works}</td><td>{currencySubtotal(row.execution_cost)}</td></tr>)}</tbody>
  </table></div>;
}
