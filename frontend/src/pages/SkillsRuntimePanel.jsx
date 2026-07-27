import { assistantApi } from '../api/assistant.js';
import { useEffect, useMemo, useState } from 'react';
import { Boxes, Play, RefreshCw, Sparkles } from 'lucide-react';
import { message } from '../store/toastStore';
import './SkillsRuntimePanel.css';

const KIND_LABEL = { domain: '处理事项', intake: '入箱识别' };

export default function SkillsRuntimePanel() {
  const [state, setState] = useState(initialState());
  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState({ bundleId: '', itemId: '' });
  const skills = useMemo(() => runtimeSkills(state.skills), [state.skills]);
  const selected = useMemo(
    () => state.skillDetails?.[selectedId] || selectedSkill(skills, selectedId),
    [skills, selectedId, state.skillDetails]
  );

  useEffect(() => { loadAll(setState); }, []);
  useEffect(() => { if (!selectedId && skills[0]) setSelectedId(skills[0].id); }, [skills, selectedId]);
  useEffect(() => { if (selectedId) loadSkillDetail(selectedId, setState); }, [selectedId]);
  useEffect(() => setForm((previous) => defaultInputs(previous, state.bundles, state.items)), [state.bundles, state.items]);

  const runSelected = () => runSkill(selected, form, setState);
  return (
    <section className="glass-card skills-runtime-panel">
      <PanelHeader loading={state.loading} onRefresh={() => loadAll(setState)} />
      {state.error && <div className="skills-runtime-error">{state.error}</div>}
      {state.notice && <div className="skills-runtime-empty compact">{state.notice}</div>}
      <div className="skills-runtime-grid">
        <SkillList selectedId={selected?.id} skills={skills} onSelect={setSelectedId} />
        <SkillDetail form={form} runs={runsForSkill(state, selected)} selected={selected} setForm={setForm} onRun={runSelected} />
      </div>
    </section>
  );
}

function PanelHeader({ loading, onRefresh }) {
  return (
    <div className="skills-runtime-head">
      <div>
        <h2><Boxes size={18} color="var(--primary)" /> Skills Runtime</h2>
        <p>展示 intake/domain skill 的启用状态、schema、依赖工具、运行历史与诊断。</p>
      </div>
      <button className="btn btn-secondary" disabled={loading} onClick={onRefresh} type="button">
        <RefreshCw size={15} className={loading ? 'spin-animation' : ''} /> 刷新
      </button>
    </div>
  );
}

function SkillList({ onSelect, selectedId, skills }) {
  if (!skills.length) return <div className="skills-runtime-empty">暂无 intake/domain skill manifest。</div>;
  return (
    <aside className="skills-runtime-list">
      {skills.map((skill) => (
        <button className={skill.id === selectedId ? 'active' : ''} key={skill.id} onClick={() => onSelect(skill.id)} type="button">
          <span className={`skills-kind ${skill.kind}`}>{KIND_LABEL[skill.kind]}</span>
          <strong>{skill.name || skill.id}</strong>
          <small>{skill.availability_status || (skill.enabled ? 'ready' : 'blocked')} · tools {(skill.required_tools || []).length}</small>
        </button>
      ))}
    </aside>
  );
}

function SkillDetail({ form, onRun, runs, selected, setForm }) {
  if (!selected) return <div className="skills-runtime-empty">选择一个 skill 查看详情。</div>;
  return (
    <main className="skills-runtime-detail">
      <div className="skills-runtime-title">
        <div>
          <span className={`skills-kind ${selected.kind}`}>{KIND_LABEL[selected.kind]}</span>
          <h3>{selected.name || selected.id}</h3>
          <p>{selected.description}</p>
        </div>
        <span className={`skills-enabled ${selected.availability_status === 'blocked' ? 'warn' : 'ok'}`}>
          {selected.load_status} · {selected.availability_status}
        </span>
      </div>
      <SkillMeta skill={selected} />
      <ManualRunControls form={form} onRun={onRun} selected={selected} setForm={setForm} />
      <RunHistory runs={runs} />
    </main>
  );
}

function SkillMeta({ skill }) {
  return (
    <div className="skills-runtime-meta">
      <ChipGroup title="Required tools" values={skill.required_tools || []} empty="无" />
      <ChipGroup title="Resolved tools" values={(skill.resolved_tools || []).map((tool) => `${tool.grant} → ${tool.provider_id}:${tool.name}`)} empty="无" />
      <ChipGroup title="Missing capabilities" values={skill.missing_capabilities || []} />
      <ChipGroup title="Primary intents" values={skill.primary_intents || []} />
      <ChipGroup title="Instruction" values={[`${skill.version} · sha256:${(skill.instruction_sha256 || '').slice(0, 12)} · ${skill.instruction_bytes || 0} bytes`]} />
      <Diagnostics diagnostics={skill.diagnostics || []} />
      {skill.instructions && <SchemaBlock title="Full SKILL.md instructions" value={skill.instructions} raw />}
      <SchemaBlock title="Input schema" value={skill.input_schema || {}} />
      <SchemaBlock title="Output schema" value={skill.output_schema || {}} />
    </div>
  );
}

function ManualRunControls({ form, onRun, selected, setForm }) {
  const field = selected.kind === 'intake' ? 'bundleId' : 'itemId';
  return (
    <div className="skills-run-controls">
      <label>
        {selected.kind === 'intake' ? 'Context bundle ID' : 'Inbox item ID'}
        <input value={form[field]} onChange={(event) => setForm({ ...form, [field]: event.target.value })} placeholder="输入数字 ID" />
      </label>
      <button className="btn" disabled={selected.availability_status === 'blocked' || !selected.enabled || !form[field]} onClick={onRun} type="button">
        <Play size={15} /> Manual run
      </button>
    </div>
  );
}

function RunHistory({ runs }) {
  if (!runs.length) return <div className="skills-runtime-empty compact">暂无运行历史。</div>;
  return (
    <div className="skills-run-history">
      <h4><Sparkles size={15} /> Run history</h4>
      {runs.map((run) => <RunRow key={`${run.kind}:${run.id}`} run={run} />)}
    </div>
  );
}

function RunRow({ run }) {
  return (
    <details className="skills-run-row">
      <summary>
        <span className={`skills-enabled ${run.status === 'failed' ? 'warn' : 'ok'}`}>
          {run.lifecycle?.execution || 'executed'} · {run.status}
        </span>
        <strong>#{run.id}</strong>
        <small>{run.input_object} #{run.input_id || run.bundle_id || run.item_id}</small>
      </summary>
      <RunLinks links={run.links || {}} />
      {!!run.error && <p className="skills-runtime-error">{run.error}</p>}
      <SchemaBlock title="Schema output" value={run.schema_output || {}} />
    </details>
  );
}

function RunLinks({ links }) {
  const entries = Object.entries(links).filter(([, value]) => value);
  if (!entries.length) return null;
  return <div className="skills-run-links">{entries.map(([key, value]) => <a href={value} key={key}>{key}</a>)}</div>;
}

function ChipGroup({ empty = '', title, values }) {
  if (!values.length && !empty) return null;
  return <div className="skills-chip-block"><span>{title}</span><div>{values.length ? values.map((value) => <em key={value}>{value}</em>) : <em>{empty}</em>}</div></div>;
}

function Diagnostics({ diagnostics }) {
  if (!diagnostics.length) return <ChipGroup title="Diagnostics" values={['ok']} />;
  return <ChipGroup title="Diagnostics" values={diagnostics.map((item) => `${item.code}: ${item.message}`)} />;
}

function SchemaBlock({ raw = false, title, value }) {
  return <details className="skills-schema"><summary>{title}</summary><pre>{raw ? value : JSON.stringify(value, null, 2)}</pre></details>;
}

function initialState() {
  return { bundles: [], domainRuns: [], error: '', intakeRuns: [], items: [], loading: true, notice: '', skillDetails: {}, skills: [] };
}

function loadSkillDetail(id, setState) {
  assistantApi.getPiSkill(id).then((result) => setState((previous) => ({
    ...previous,
    skillDetails: { ...previous.skillDetails, [id]: result.skill }
  }))).catch((error) => setState((previous) => ({
    ...previous,
    error: error.message || `加载 skill ${id} 失败`
  })));
}

function loadAll(setState) {
  setState((previous) => ({ ...previous, loading: true }));
  Promise.all([
    assistantApi.getPiSkills(),
    optionalRuntimeList(() => assistantApi.getPiSkillIntakeRuns({ limit: 50 })),
    optionalRuntimeList(() => assistantApi.getPiSkillDomainRuns({ limit: 50 })),
    optionalRuntimeList(() => assistantApi.getPiAttentionContextBundles({ limit: 20 })),
    optionalRuntimeList(() => assistantApi.getPiAttentionItems({ status: '', limit: 20 })),
  ]).then(([skills, intakeRuns, domainRuns, bundles, items]) => setState((previous) => ({
    ...previous,
    bundles: bundles.value,
    domainRuns: domainRuns.value,
    error: '',
    intakeRuns: intakeRuns.value,
    items: items.value,
    loading: false,
    notice: runtimeNotice([intakeRuns, domainRuns, bundles, items]),
    skills: skills.skills || []
  }))).catch((error) => setState((previous) => ({ ...previous, error: error.message || '读取 skills runtime 失败', loading: false })));
}

async function optionalRuntimeList(read) {
  try {
    return { missing: false, value: await read() };
  } catch (error) {
    if (error.status === 404) return { missing: true, value: [] };
    throw error;
  }
}

function runtimeNotice(results) {
  if (!results.some((result) => result.missing)) return '';
  return '部分 Skills runtime history / Inbox API 尚未在当前 runtime 启用；这里先展示已可用的 skill manifest 与 coming soon 空态。';
}

function runtimeSkills(skills) {
  return (skills || []).filter((skill) => skill.kind === 'intake' || skill.kind === 'domain');
}

function selectedSkill(skills, selectedId) {
  return skills.find((skill) => skill.id === selectedId) || skills[0] || null;
}

function defaultInputs(form, bundles, items) {
  return {
    bundleId: form.bundleId || String(bundles[0]?.id || ''),
    itemId: form.itemId || String(items[0]?.id || ''),
  };
}

function runsForSkill(state, skill) {
  if (!skill) return [];
  const runs = skill.kind === 'intake' ? state.intakeRuns : state.domainRuns;
  return (runs || []).filter((run) => run.skill_id === skill.id).slice(0, 12);
}

async function runSkill(skill, form, setState) {
  if (!skill) return;
  try {
    if (skill.kind === 'intake') await assistantApi.runPiSkillIntake(skill.id, Number(form.bundleId));
    else await assistantApi.runPiSkillDomain(skill.id, Number(form.itemId));
    message.success('Manual skill run 已创建');
    loadAll(setState);
  } catch (error) {
    message.error(error.message || 'Manual skill run 失败');
  }
}
