import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Check, Download, LoaderCircle, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import { skillLibraryApi } from '../api/skillLibrary.js';
import { projectsApi } from '../api/projects.js';
import './SkillLibraryPanel.css';

const EMPTY = { installed: [], discovered: [], diagnostics: [] };
const OPERATIONS = { enable: '启用', disable: '停用', update: '更新', rollback: '回滚', uninstall: '卸载' };
const SOURCE_LABELS = { git: 'Git 仓库', local: '本地目录', inline: '直接编写' };

export default function SkillLibraryPanel() {
  const [library, setLibrary] = useState(EMPTY);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState('');
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const [detail, setDetail] = useState(null);
  const [installing, setInstalling] = useState(false);
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const sequence = useRef(0);
  const detailSequence = useRef(0);

  const load = useCallback(async () => {
    const current = ++sequence.current;
    setLoading(true);
    try {
      const result = await skillLibraryApi.list(projectId);
      if (current === sequence.current) setLibrary(result);
    } catch (failure) { if (current === sequence.current) setError(failure.message); }
    finally { if (current === sequence.current) setLoading(false); }
  }, [projectId]);

  const invalidateRequests = useCallback(() => { sequence.current++; detailSequence.current++; }, []);
  useEffect(() => { load(); return invalidateRequests; }, [load, invalidateRequests]);
  useEffect(() => {
    let active = true;
    projectsApi.getProjects().then(result => { if (active) setProjects(Array.isArray(result) ? result : result.projects || []); }).catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, []);

  const select = useCallback(async key => {
    const current = ++detailSequence.current;
    setSelectedKey(key); setDetail(null); setError('');
    try { const result = await skillLibraryApi.detail(key); if (current === detailSequence.current) setDetail(result); }
    catch (failure) { if (current === detailSequence.current) setError(failure.message); }
  }, []);

  const mutate = async (label, action, key = '') => {
    if (busy) return;
    setBusy(label); setError(''); setNotice('');
    try {
      const result = await action();
      if (result?.status === 'pending' || result?.status === 'denied' || result?.decision === 'ask') throw new Error('操作尚未获准，请在对话中处理权限请求。');
      setNotice(`${label}完成${result?.skill?.cleanup_pending ? '，技能已停止加载，版本文件清理失败，请检查目录权限' : result?.verification?.status === 'blocked' ? '，存在依赖或加载问题，请查看验证结果' : ''}`);
      await load();
      if (key) await select(key);
      else { setSelectedKey(''); setDetail(null); detailSequence.current++; }
      return result;
    } catch (failure) { setError(failure.message); return null; }
    finally { setBusy(''); }
  };

  const install = async body => {
    const result = await mutate('安装', () => skillLibraryApi.install(body));
    if (result?.skill) { setInstalling(false); await select(result.skill.key); }
  };
  const manage = (skill, operation, source) => mutate(OPERATIONS[operation], () => skillLibraryApi.manage({ key: skill.key, expected_revision: skill.revision, operation, ...(source ? { source } : {}) }), operation === 'uninstall' ? '' : skill.key);
  const items = library.installed.filter(item => `${item.id} ${item.source.location || ''}`.toLowerCase().includes(query.toLowerCase()));
  const otherSkills = library.discovered.filter(item => !library.installed.some(skill => skill.id === item.id));
  const selected = library.installed.find(item => item.key === selectedKey);
  useEffect(() => {
    if (selected && detail && (detail.skill.revision !== selected.revision || detail.skill.enabled !== selected.enabled)) select(selected.key);
  }, [detail, select, selected]);

  return (
    <section className="skill-library" aria-label="技能库" aria-busy={Boolean(busy) || loading}>
      <div className="skill-library-heading">
        <div><h2><BookOpen size={16} aria-hidden="true" /> 技能库</h2><p>安装技能，在对话中按需使用。版本、来源与启用状态统一管理。</p>{library.pi_version && <small>Pi {library.pi_version}</small>}</div>
        <div className="skill-library-actions">
          <button type="button" className="btn btn-secondary" disabled={Boolean(busy) || loading} onClick={load}><RefreshCw size={14} />刷新</button>
          <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => setInstalling(value => !value)}><Plus size={14} />{installing ? '收起安装' : '安装技能'}</button>
        </div>
      </div>
      <div className="skill-library-filters">
        <label>作用域<select aria-label="技能作用域" value={projectId} disabled={Boolean(busy)} onChange={event => { setProjectId(event.target.value); setSelectedKey(''); setDetail(null); setError(''); setNotice(''); detailSequence.current++; }}>
          <option value="">整个玄武实例</option>{projects.map(project => <option value={project.id} key={project.id}>{project.name || project.id}</option>)}
        </select></label>
        <label>查找技能<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="名称或来源" /></label>
      </div>
      {error && <p className="skill-library-error" role="alert">{error}</p>}
      {(busy || notice) && <p className="skill-library-notice" role="status">{busy ? <><LoaderCircle size={14} className="spin-animation" />正在{busy}…</> : <><Check size={14} />{notice}</>}</p>}
      {installing && <InstallForm projectId={projectId} busy={Boolean(busy)} onInstall={install} />}
      {loading ? <p className="skill-library-empty" role="status">正在读取技能库…</p> : (
        <div className="skill-library-grid">
          <div className="skill-library-list" aria-label="已安装技能">
            {items.length ? items.map(skill => <button type="button" key={skill.key} aria-current={selectedKey === skill.key} className={selectedKey === skill.key ? 'active' : ''} onClick={() => select(skill.key)} disabled={Boolean(busy)}>
              <strong>{skill.id}</strong><span>{skill.enabled ? (skill.effective_enabled === false ? '受策略或项目版本限制' : '已启用') : '已停用'} · {skill.scope === 'project' ? '当前项目' : '整个实例'}</span><small>{SOURCE_LABELS[skill.source.kind]}</small>
            </button>) : <p className="skill-library-empty">{query ? '没有匹配的技能。' : '尚未安装技能。可以从仓库、本地目录或技能说明开始。'}</p>}
          </div>
          {selected ? <SkillDetail key={selected.key} detail={detail} skill={selected} busy={Boolean(busy)} onManage={manage} onVerify={() => mutate('验证', () => skillLibraryApi.verify(selected.key), selected.key)} /> : <div className="skill-library-empty">选择技能查看说明、版本和验证结果。项目范围也会显示整个实例共享的技能。</div>}
        </div>
      )}
      <details className="skill-library-discovered"><summary>已发现的其他技能（{otherSkills.length}）</summary><p>这些目录中的技能可供查询；要在对话中使用，需要安装到技能库或配置项目允许列表。</p>
        <ul>{otherSkills.map(item => <li key={item.id}><strong>{item.name}</strong><span>{item.description}</span><code>{item.source_path}</code></li>)}</ul>
      </details>
    </section>
  );
}

function InstallForm({ projectId, busy, onInstall }) {
  const [draft, setDraft] = useState({ id: '', kind: 'git', location: '', ref: '', subdirectory: '', content: '', enabled: true });
  const [inspection, setInspection] = useState({ busy: false, error: '', candidates: [] });
  const update = event => { setDraft(previous => ({ ...previous, [event.target.name]: event.target.type === 'checkbox' ? event.target.checked : event.target.value })); setInspection({ busy: false, error: '', candidates: [] }); };
  const sourceInput = () => draft.kind === 'inline' ? { kind: 'inline', content: draft.content } : { kind: draft.kind, location: draft.location.trim(), ...(draft.ref && draft.kind === 'git' ? { ref: draft.ref.trim() } : {}), ...(draft.subdirectory ? { subdirectory: draft.subdirectory.trim() } : {}) };
  const inspect = async () => {
    setInspection({ busy: true, error: '', candidates: [] });
    try {
      const result = await skillLibraryApi.inspect(sourceInput());
      setInspection({ busy: false, error: '', candidates: result.candidates });
    } catch (error) { setInspection({ busy: false, error: error.message, candidates: [] }); }
  };
  const submit = event => {
    event.preventDefault();
    const source = sourceInput();
    onInstall({ id: draft.id.trim(), scope: projectId ? 'project' : 'instance', ...(projectId ? { project_id: projectId } : {}), source, enabled: draft.enabled });
  };
  return <form className="skill-library-form" onSubmit={submit} aria-busy={busy || inspection.busy}>
    <h3>安装到{projectId ? '当前项目' : '整个玄武实例'}</h3>
    <div className="skill-library-form-fields">
      <label>技能名称<input name="id" value={draft.id} onChange={update} required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={64} placeholder="与 SKILL.md 的 name 一致" disabled={busy || inspection.busy} /></label>
      <label>安装来源<select name="kind" value={draft.kind} onChange={update} disabled={busy || inspection.busy}>{Object.entries(SOURCE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {draft.kind !== 'inline' && <label className="skill-library-wide">{draft.kind === 'git' ? '仓库地址' : '本地绝对目录'}<input name="location" value={draft.location} onChange={update} required disabled={busy || inspection.busy} placeholder={draft.kind === 'git' ? 'https://github.com/owner/repository' : '/absolute/path/to/skill'} /></label>}
      {draft.kind === 'git' && <label>分支或标签<input name="ref" value={draft.ref} onChange={update} disabled={busy || inspection.busy} placeholder="默认分支" /></label>}
      {draft.kind !== 'inline' && <label>技能子目录<input name="subdirectory" value={draft.subdirectory} onChange={update} disabled={busy || inspection.busy} placeholder="例如 skills/my-skill（可选）" /></label>}
      {draft.kind === 'inline' && <label className="skill-library-wide">SKILL.md 内容<textarea name="content" value={draft.content} onChange={update} required rows={10} maxLength={131072} disabled={busy || inspection.busy} placeholder={'---\nname: my-skill\ndescription: 何时使用这个技能\n---\n具体操作说明'} /></label>}
    </div>
    <label className="skill-library-checkbox"><input type="checkbox" name="enabled" checked={draft.enabled} onChange={update} disabled={busy || inspection.busy} />安装后启用</label>
    {inspection.error && <p className="skill-library-error" role="alert">{inspection.error}</p>}
    {inspection.candidates.length > 0 && <div className="skill-library-actions" aria-label="来源中的技能">{inspection.candidates.map(candidate => <button key={`${candidate.id}-${candidate.subdirectory}`} className="btn btn-secondary" type="button" disabled={busy || inspection.busy} onClick={() => setDraft(previous => ({ ...previous, id: candidate.id, subdirectory: candidate.subdirectory }))}>{candidate.id}</button>)}</div>}
    <div className="skill-library-actions"><button type="button" className="btn btn-secondary" disabled={busy || inspection.busy} onClick={inspect}>{inspection.busy ? <LoaderCircle size={14} className="spin-animation" /> : <RefreshCw size={14} />}识别技能</button><button type="submit" className="btn btn-secondary" disabled={busy || inspection.busy}><Download size={14} />安装并验证</button><small>支持携带 references、scripts 和 assets；依赖安装及脚本运行由对话按任务安排。</small></div>
  </form>;
}

function SkillDetail({ detail, skill, busy, onManage, onVerify }) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState('');
  const [editRevision, setEditRevision] = useState('');
  const verification = detail?.verification;
  return <div className="skill-library-detail">
    <div><h3>{skill.id}</h3><p>{skill.source.location || '直接编写的技能说明'}</p></div>
    <dl className="skill-library-facts"><div><dt>STATUS</dt><dd>{skill.enabled ? (skill.effective_enabled === false ? '受策略或项目版本限制' : '已启用') : '已停用'}</dd></div><div><dt>VERSION</dt><dd>{skill.digest.slice(0, 12)}</dd></div><div><dt>SOURCE</dt><dd>{SOURCE_LABELS[skill.source.kind]}</dd></div></dl>
    <div className="skill-library-actions">
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onManage(skill, skill.enabled ? 'disable' : 'enable')}>{skill.enabled ? '停用' : '启用'}</button>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={onVerify}><ShieldCheck size={14} />验证加载</button>
      {skill.source.kind === 'inline' ? <button type="button" className="btn btn-secondary" disabled={busy || !detail} onClick={() => { setContent(detail.instructions); setEditRevision(skill.revision); setEditing(value => !value); }}>编辑内容</button> : <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onManage(skill, 'update')}>更新版本</button>}
      <button type="button" className="btn btn-secondary" disabled={busy || skill.revisions.length < 2} onClick={() => onManage(skill, 'rollback')}>回滚版本</button>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirmRemove(value => !value)}>卸载</button>
    </div>
    {confirmRemove && <div className="skill-library-confirm"><p>卸载 {skill.id} 后，新的对话任务将不再加载它。</p><div className="skill-library-actions"><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onManage(skill, 'uninstall')}>确认卸载</button><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirmRemove(false)}>取消</button></div></div>}
    {editing && <form className="skill-library-form" onSubmit={async event => { event.preventDefault(); const result = await onManage({ ...skill, revision: editRevision }, 'update', { kind: 'inline', content }); if (result) setEditing(false); }}><label>SKILL.md<textarea rows={12} value={content} onChange={event => setContent(event.target.value)} disabled={busy} required /></label><button type="submit" className="btn btn-secondary" disabled={busy}>保存新版本</button></form>}
    {!detail ? <p role="status">正在读取详情…</p> : <>
      <div className="skill-library-verification"><h4>加载验证 · {verification.status === 'ready' ? '可用' : verification.status === 'disabled' ? '已停用' : '待处理'}</h4><p>{verification.note}</p>{verification.diagnostics.map((item, index) => <p className="skill-library-error" key={`${item.code}-${index}`}>{item.message}</p>)}{verification.scripts.length > 0 && <p>附带 {verification.scripts.length} 个脚本，可在对话中安排执行任务。</p>}</div>
      <details open className="skill-library-instructions"><summary>技能说明</summary><pre>{detail.instructions}</pre></details>
      <details><summary>版本历史（{skill.revisions.length}）</summary><ul>{[...skill.revisions].reverse().map(item => <li key={item.revision}><code>{item.digest.slice(0, 12)}</code> · {new Date(item.installed_at).toLocaleString()} {item.revision === skill.revision ? '· 当前版本' : ''}</li>)}</ul></details>
    </>}
  </div>;
}
