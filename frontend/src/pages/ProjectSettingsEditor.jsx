import { projectNameFromPath } from './projects/projectSettingsForm.js';
import AgentProfileSelectOptions from '../components/AgentProfileSelectOptions.jsx';
import { nodeStatus } from './remoteNodesModel.js';
import useProjectSettingsEditor from './projects/useProjectSettingsEditor.js';
import ProjectRuntimeFields from './projects/ProjectRuntimeFields.jsx';
import './ProjectSettingsEditor.css';

export default function ProjectSettingsEditor({ layout = 'inline', mode = 'edit', onCancel, onSaved, project = null }) {
  const {
    ui, english, remote, selectedNode, presetCatalog,
    modelOptions, providerOptions, setFormField, setProjectNode, setProjectRuntimeField,
    handleSubmit, providerReady, historicalProviderPreserved,
  } = useProjectSettingsEditor({ mode, project, onSaved });
  const modal = layout === 'modal';
  return (
    <form className={modal ? 'project-config-modal-form' : 'project-settings-editor-form'} onSubmit={handleSubmit}>
      <div className={modal ? 'project-config-modal-body' : 'project-settings-editor-body'}>
        {ui.formError && <div className="project-settings-error" role="alert">{ui.formError}</div>}

        {ui.nodes.length > 0 || remote ? (
          <div className="form-group">
            <label><span className="ds-mono-label">运行位置</span></label>
            <select
              aria-label="运行位置"
              className="form-control"
              disabled={mode === 'edit'}
              onChange={event => setProjectNode(event.target.value)}
              value={ui.formNodeId}
            >
              <option value="">本机（玄武所在服务器）</option>
              {ui.nodes.map(node => (
                <option key={node.id} value={node.id}>{node.name}（{nodeStatus(node).label}）</option>
              ))}
              {remote && !selectedNode ? <option value={ui.formNodeId}>{ui.formNodeId}（读取中）</option> : null}
            </select>
            <span className="project-settings-hint">
              {mode === 'edit'
                ? '项目创建后不能更换运行位置。'
                : remote
                  ? '任务会在该节点上执行。远程项目暂不支持 Git 验收与交付。'
                  : '选择远程节点后，任务在那台机器上执行。'}
            </span>
          </div>
        ) : null}

        <div className="form-group">
          <label><span className="ds-mono-label">项目路径 *</span></label>
          <input
            autoFocus={mode === 'create'}
            className="form-control"
            onChange={event => setFormField('formCwd', event.target.value)}
            placeholder={remote ? '节点上的绝对路径，例如 /home/me/code/project' : '/Users/username/projects/project-name'}
            required
            type="text"
            value={ui.formCwd}
          />
          <span className="project-settings-hint">
            {remote ? '填写节点上项目根目录的绝对路径，需位于节点 --root 允许的目录内。' : '填写项目根目录的绝对路径。'}项目名称会自动识别为：{ui.formCwd.trim() ? projectNameFromPath(ui.formCwd) : '—'}
          </span>
        </div>

        {mode === 'create' ? (
          <details className="project-settings-advanced">
            <summary>高级运行配置（可选）</summary>
            <p>不确定时无需修改。默认使用无人值守开发策略，允许当前编程工具使用本机开发能力且不逐次等待确认。</p>
            <ProjectRuntimeFields modelOptions={modelOptions} onFieldChange={setProjectRuntimeField} providerOptions={providerOptions} ui={ui} />
          </details>
        ) : (
          <>
            <ProjectRuntimeFields modelOptions={modelOptions} onFieldChange={setProjectRuntimeField} providerOptions={providerOptions} ui={ui} />
            <label className="form-group">
              <span className="ds-mono-label">{english ? 'Execution preset' : '执行预设'}</span>
              <select className="form-control" value={ui.formAgentProfileId}
                disabled={ui.saving || ui.profilesLoading || presetCatalog.loading || Boolean(presetCatalog.error)}
                onChange={event => setFormField('formAgentProfileId', event.target.value)}>
                <option value="">{english ? 'Use project defaults' : '沿用项目设置'}</option>
                <AgentProfileSelectOptions catalog={presetCatalog.catalog} profiles={ui.profiles} selectedProfileID={ui.formAgentProfileId} />
              </select>
            </label>
            {presetCatalog.error ? <p className="project-settings-error" role="alert">{presetCatalog.error}</p> : null}
            <p className="project-settings-hint">
              {english ? 'Execution preset' : '执行预设'}：{ui.profiles.find(profile => profile.id === ui.formAgentProfileId)?.name || (ui.formAgentProfileId === project?.default_agent_profile_id ? project?.default_agent_profile?.name : '') || ui.formAgentProfileId || (english ? 'Project defaults' : '沿用项目设置')} · {' '}
              <a href="#/settings?section=advanced:presets" onClick={onCancel}>{english ? 'Edit in Advanced → Execution presets' : '在 高级 → 执行预设 中修改'}</a>
              {ui.profileError ? <span role="alert">{ui.profileError}</span> : null}
            </p>
          </>
        )}
      </div>

      <div className={modal ? 'project-config-modal-footer' : 'project-settings-editor-footer'}>
        {onCancel && <button className="btn btn-secondary" disabled={ui.saving} onClick={onCancel} type="button">取消</button>}
        <button className="btn btn-primary" disabled={ui.saving || ui.providerCatalogLoading || presetCatalog.loading || Boolean(presetCatalog.error) || (!providerReady && !historicalProviderPreserved)} type="submit">
          {ui.saving ? '正在保存…' : mode === 'create' ? '添加并接管' : '保存项目设置'}
        </button>
      </div>
    </form>
  );
}
