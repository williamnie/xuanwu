import { useCallback, useEffect, useReducer, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import { githubSettingsApi } from '../api/githubSettings.js';
import { GITHUB_OPERATIONS, githubApplicationLabel, githubConnectionLabel, githubDraftDirty, githubIntakeLabel, githubPhaseLabel, githubSettingsReducer, initialGitHubSettings, newGitHubRepository } from './githubSettingsModel.js';
import './GitHubSettingsPanel.css';

export default function GitHubSettingsPanel() {
  const [state, dispatch] = useReducer(githubSettingsReducer, undefined, initialGitHubSettings);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const load = useCallback(async (signal) => {
    const current = ++sequence.current;
    dispatch({ type: 'start', operation: 'load' });
    try {
      const remote = await githubSettingsApi.get(signal ? { signal } : {});
      if (!signal?.aborted && current === sequence.current) dispatch({ type: 'loaded', remote });
    } catch (error) {
      if (!signal?.aborted && current === sequence.current) dispatch({ type: 'error', message: error.message, status: error.status });
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => { controller.abort(); sequence.current += 1; };
  }, [load]);
  async function action(operation) {
    if (state.busy || inFlight.current) return;
    inFlight.current = true;
    const current = ++sequence.current;
    dispatch({ type: 'start', operation });
    try {
      const response = operation === 'save' ? await githubSettingsApi.save(state.revision, state.draft)
        : operation === 'apply' ? await githubSettingsApi.reload(state.remote.revision) : await githubSettingsApi.test(state.draft);
      if (current === sequence.current) dispatch(operation === 'test' ? { type: 'tested', result: response } : { type: operation === 'save' ? 'saved' : 'applied', remote: response });
    } catch (error) {
      let remote;
      if (error.status === 409) {
        try { remote = await githubSettingsApi.get(); } catch { /* 读取失败时保留草稿，等待显式刷新后才能解决冲突。 */ }
      }
      if (current === sequence.current) dispatch({ type: 'error', message: error.message || '操作失败，请重试。', status: error.status, remote });
    } finally { inFlight.current = false; }
  }
  return <GitHubSettingsView state={state} dispatch={dispatch} onRefresh={() => load()} onAction={action} />;
}

export function GitHubSettingsView({ state, dispatch, onRefresh, onAction }) {
  const { remote, draft, busy } = state;
  const dirty = githubDraftDirty(state);
  const edit = patch => dispatch({ type: 'edit', draft: { ...draft, ...patch } });
  return (
    <section className="github-settings" aria-label="GitHub 仓库接管">
      <header className="github-settings__header">
        <div><small>GITHUB INTAKE</small><h2>GitHub 仓库接管</h2></div>
        <button className="btn btn-secondary" type="button" disabled={busy} onClick={onRefresh}><RefreshCw size={14} aria-hidden="true" /> 刷新状态</button>
      </header>
      <p>将带指定标签的 GitHub Issue 关联到已有项目，查看调查、修复、求助与 PR 进度。</p>
      {state.error && <p className="github-settings__error" role="alert">{state.error}</p>}
      {!remote ? <p role="status">{busy ? '正在读取接管配置…' : '配置未加载，请刷新重试。'}</p> : <>
        <div className="github-settings__facts" aria-live="polite">
          <div><small>APPLICATION</small><strong>{githubApplicationLabel(remote.application.status)}</strong></div>
          <div><small>POLLING</small><strong>{remote.runtime.enabled ? remote.runtime.running ? '正在对账' : '已启用' : '已停用'}</strong></div>
          <div><small>LAST POLL</small><strong>{remote.runtime.last_run_at || '尚未轮询'}</strong></div>
        </div>
        {remote.runtime.last_error && <p className="github-settings__error">最近轮询异常：{remote.runtime.last_error}</p>}
        <p>{remote.permissions.note}</p>
        <form onSubmit={event => { event.preventDefault(); onAction('save'); }}>
          <fieldset className="github-settings__form" disabled={busy}>
            <legend className="sr-only">仓库接管配置</legend>
            <label className="github-settings__check"><input type="checkbox" checked={draft.enabled} onChange={event => edit({ enabled: event.target.checked })} />启用仓库接管</label>
            <div className="github-settings__fields">
              <label>认证方式<select className="form-control" value={draft.auth.mode} onChange={event => edit({ auth: { ...draft.auth, mode: event.target.value } })}><option value="connector">复用 GitHub 连接器凭据</option><option value="gh-cli">本机 gh 认证</option><option value="github-app">GitHub App 凭据引用</option></select></label>
              <label>轮询间隔（秒）<input className="form-control" type="number" min="15" max="3600" step="1" required value={draft.pollIntervalSeconds} onChange={event => edit({ pollIntervalSeconds: Number(event.target.value) })} /></label>
            </div>
            <p>复用已有凭据，不输入或复制 token。当前引用：{remote.credential.reference || '未配置'}。认证变更需保存并应用。</p>
            {draft.auth.mode === 'github-app' && <div className="github-settings__fields">{[['appId', 'App ID'], ['installationId', 'Installation ID'], ['privateKeyRef', '私钥引用（secret:// 或 env://）']].map(([key, title]) => <label key={key}>{title}<input className="form-control" required value={draft.auth[key]} onChange={event => edit({ auth: { ...draft.auth, [key]: event.target.value } })} /></label>)}</div>}
            {draft.repositories.map((repository, index) => <RepositoryEditor key={index} repository={repository} index={index} projects={remote.projects}
              onChange={patch => edit({ repositories: draft.repositories.map((item, i) => i === index ? { ...item, ...patch } : item) })}
              onRemove={() => edit({ repositories: draft.repositories.filter((_, i) => i !== index) })} />)}
            <div><button className="btn btn-secondary" type="button" disabled={draft.repositories.length >= 32} onClick={() => edit({ repositories: [...draft.repositories, newGitHubRepository(remote.projects[0]?.id)] })}>添加仓库</button></div>
            <p>保存只写入配置；点击“应用配置”后，后续轮询按新规则处理。移除映射或停用不会取消已有 Work；标签撤回需由仍启用的轮询观察。连接测试只读当前草稿，不保存、不触发同步。</p>
            <div className="github-settings__actions">
              <span>{dirty ? '有未保存的修改' : '草稿与保存版本一致'}</span>
              <button className="btn btn-secondary" type="button" disabled={!draft.repositories.length} aria-busy={busy && state.operation === 'test'} onClick={() => onAction('test')}>测试连接</button>
              <button className="btn btn-primary" type="submit" disabled={state.conflict} aria-busy={busy && state.operation === 'save'}>保存配置</button>
              <button className="btn btn-secondary" type="button" disabled={dirty || state.conflict || remote.application.status !== 'pending'} onClick={() => onAction('apply')}>应用配置</button>
            </div>
          </fieldset>
        </form>
        {state.conflict && <div className="github-settings__conflict" role="status"><p>配置冲突或应用失败；草稿已保留。{state.conflictNeedsRefresh ? '请先刷新状态，读取最新保存版本。' : '已读取最新保存版本，请核对后选择。'}</p>
          <details><summary>{state.conflictNeedsRefresh ? '查看上次读取的保存版本' : '查看最新保存版本'}</summary><pre>{JSON.stringify(remote.settings, null, 2)}</pre></details>
          <div className="github-settings__actions"><button className="btn btn-secondary" disabled={busy || state.conflictNeedsRefresh} onClick={() => dispatch({ type: 'use-server' })}>使用保存版本</button><button className="btn btn-secondary" disabled={busy || state.conflictNeedsRefresh} onClick={() => dispatch({ type: 'rebase' })}>保留草稿重试</button></div>
        </div>}
        {state.notice && <p role="status">{state.notice}</p>}
        {state.testResult && <div className="github-settings__results" role="status">
          <h3>连接测试结果</h3>{state.testResult.repositories.map(item => <p key={item.repository}><strong>{item.repository}</strong> · {githubConnectionLabel(item.status)}</p>)}
          <p>测试仅验证读取连接与标签；评论、代码推送和 PR 写权限尚未验证，仍需既有授权与执行门禁。</p>
        </div>}
        {remote.application.status === 'pending' && <details><summary>查看当前生效规则</summary><pre>{JSON.stringify(remote.application.active_settings, null, 2)}</pre></details>}
        <CaseStatus repositories={remote.repositories} />
      </>}
    </section>
  );
}

function RepositoryEditor({ repository, index, projects, onChange, onRemove }) {
  return <fieldset className="github-settings__repository">
    <legend>仓库 {index + 1}</legend>
    <div className="github-settings__fields">
      <label>仓库（owner/repository）<input className="form-control" required value={repository.repository} onChange={event => onChange({ repository: event.target.value })} /></label>
      <label>关联项目<select className="form-control" required value={repository.projectId} onChange={event => onChange({ projectId: event.target.value })}><option value="">选择已有项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name} · {project.id}</option>)}</select></label>
      <label>接管标签<input className="form-control" required maxLength={50} value={repository.intakeLabel} onChange={event => onChange({ intakeLabel: event.target.value })} /></label>
      <label>目标分支（留空使用默认分支）<input className="form-control" value={repository.baseBranch} onChange={event => onChange({ baseBranch: event.target.value })} /></label>
    </div>
    <div className="github-settings__operations">{GITHUB_OPERATIONS.map(([key, title]) => <label className="github-settings__check" key={key}><input type="checkbox" checked={repository[key]} onChange={event => onChange({ [key]: event.target.checked })} />{title}</label>)}</div>
    <p>新仓库的自动操作默认关闭。关单只作用于已合并且通过 CI 的 PR，不会自动合并或部署。</p>
    <details><summary>CI 失败处理</summary><div className="github-settings__fields"><label>处理方式<select className="form-control" value={repository.ciFailureMode} onChange={event => onChange({ ciFailureMode: event.target.value })}><option value="repair">诊断并修复本任务回归</option><option value="report_only">只报告外部限制</option></select></label><label>外部限制原因<input className="form-control" maxLength={500} required={repository.ciFailureMode === 'report_only'} value={repository.ciFailureReason} onChange={event => onChange({ ciFailureReason: event.target.value })} /></label></div></details>
    <div><button className="btn btn-secondary" type="button" onClick={onRemove}>移除映射</button></div>
  </fieldset>;
}
function CaseStatus({ repositories }) {
  return <div className="github-settings__cases"><h3>接管进度</h3><p>展示最近已观察的 Case；标签匹配按保存版本解释。阶段与 Work 状态分开显示，Work 完成不代表 PR 已合并。</p>
    {!repositories.length && <p>尚未配置仓库。</p>}
    {repositories.map(repository => <section key={repository.repository}><h4>{repository.repository}</h4><p>项目 {repository.project_id} · 接管标签 {repository.intake_label}</p>
      {!repository.cases.length ? <p>尚无 Case。请检查配置是否已应用、读取权限及 Issue 接管标签。</p> : <ol>{repository.cases.map(item => <li key={item.issue_number}>
        <div className="github-settings__case-heading"><strong>#{item.issue_number} · {githubPhaseLabel(item.phase)}</strong><span>CASE {item.stage}</span></div>
        <p>{githubIntakeLabel(item.intake_status)} · GitHub {item.external_state} · 来源版本 {item.source_revision}</p>
        <p>{item.issue_id ? `Work #${item.issue_id} · ${item.work_status}` : '尚未创建 Work'}{item.pull_request_number ? ` · PR #${item.pull_request_number}` : ' · 尚无 PR'}</p>
        {item.last_error && <p className="github-settings__error">{item.last_error}</p>}
      </li>)}</ol>}{repository.truncated && <p>显示最近 100 项，共 {repository.total} 项。</p>}
    </section>)}
  </div>;
}
