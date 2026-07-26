import { systemApi } from '../api/system.js';
import { projectsApi } from '../api/projects.js';
import { useImmer } from 'use-immer';
import './Projects.css';
import { message } from '../store/toastStore';
import {
  selectBackendOnline,
  selectIssues,
  selectProjects,
  selectRefreshData,
  useDataStore,
} from '../store/dataStore';
import { 
  FolderPlus, 
  Folder, 
  RefreshCw,
  CheckCircle2,
  Settings, 
  Trash2, 
  Play, 
  Square, 
  X,
  AlertCircle
} from 'lucide-react';
import ProjectHoldNotice from './ProjectHoldNotice';
import { PROVIDER_OPTIONS, capabilitySummary, providerLabel } from './sessions/sessionOptions';
import {
  agentProfilePayload,
  emptyAgentProfileForm,
  normalizeAgentProfileForm,
  summarizeAgentProfile,
} from '../utils/agentProfiles';
import {
  serviceTierLabel,
  serviceTierOptions,
} from '../utils/serviceTier';

const DEFAULT_PROJECT_NAME = 'project';
const DEFAULT_CODEX_MODEL = 'codex-default';
const DEFAULT_PROVIDER = 'codex';

function projectNameFromPath(cwd) {
  const trimmed = cwd.trim().replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() || DEFAULT_PROJECT_NAME;
}

function projectIdFromPath(cwd) {
  const base = projectNameFromPath(cwd).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return base.replace(/^-+|-+$/g, '') || DEFAULT_PROJECT_NAME;
}

function compactPath(cwd = '') {
  const text = String(cwd || '').trim().replace(/[\\/]+$/, '');
  const parts = text.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 3) return text || '—';
  return `…/${parts.slice(-2).join('/')}`;
}

function normalizeCodexModel(model) {
  return String(model || '').trim() || DEFAULT_CODEX_MODEL;
}

function buildCodexModelOptions(models, ...selectedValues) {
  const options = [];
  const seen = new Set();
  const pushOption = (value, label) => {
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue || seen.has(normalizedValue)) return;
    seen.add(normalizedValue);
    options.push({ value: normalizedValue, label: String(label || normalizedValue).trim() || normalizedValue });
  };

  pushOption(DEFAULT_CODEX_MODEL, '系统默认模型');

  const liveModels = Array.isArray(models) ? models.filter(model => !model?.hidden) : [];
  liveModels.forEach(model => pushOption(model?.id || model?.model, model?.displayName || model?.name || model?.id || model?.model));

  selectedValues.forEach(value => {
    const normalizedValue = normalizeCodexModel(value);
    if (normalizedValue !== DEFAULT_CODEX_MODEL) pushOption(normalizedValue, normalizedValue);
  });

  return options;
}

export default function Projects() {
  const projects = useDataStore(selectProjects);
  const issues = useDataStore(selectIssues);
  const backendOnline = useDataStore(selectBackendOnline);
  const refreshData = useDataStore(selectRefreshData);
  const [ui, updateUi] = useImmer({
    syncing: false,
    syncResult: null,
    isModalOpen: false,
    modalMode: 'create', // 'create' | 'edit'
    selectedProjectId: null,
    formCwd: '',
    formProvider: DEFAULT_PROVIDER,
    formProviderConfig: '{}',
    formPiManaged: true,
    formModel: DEFAULT_CODEX_MODEL,
    formApproval: 'never',
    formSandbox: 'workspace-write',
    formServiceTier: '',
    formAgentProfileId: '',
    formError: '',
    resumingHoldProjectId: '',
    piBindingProjectId: '',
    profiles: [],
    profilesLoading: false,
    profileForm: emptyAgentProfileForm(),
    profileError: '',
    codexModels: [],
    codexModelsLoading: false,
    codexModelsError: '',
  });

  const {
    syncing,
    syncResult,
    isModalOpen,
    modalMode,
    selectedProjectId,
    formCwd,
    formProvider,
    formProviderConfig,
    formPiManaged,
    formModel,
    formApproval,
    formSandbox,
    formServiceTier,
    formAgentProfileId,
    formError,
    resumingHoldProjectId,
    piBindingProjectId,
    profiles,
    profilesLoading,
    profileForm,
    profileError,
    codexModels,
    codexModelsLoading,
    codexModelsError,
  } = ui;

  const codexModelOptions = buildCodexModelOptions(codexModels, formModel, profileForm.model);

  const closeModal = () => {
    updateUi(draft => {
      draft.isModalOpen = false;
    });
  };

  const setFormField = (field, value) => {
    updateUi(draft => {
      draft[field] = value;
    });
  };

  const setProfileFormField = (field, value) => {
    updateUi(draft => {
      draft.profileForm[field] = value;
    });
  };

  const loadAgentProfiles = async () => {
    updateUi(draft => {
      draft.profilesLoading = true;
      draft.profileError = '';
    });
    try {
      const list = await projectsApi.getAgentProfiles();
      updateUi(draft => {
        draft.profiles = list || [];
      });
    } catch (err) {
      updateUi(draft => {
        draft.profileError = err.message || '加载 Agent Profile 失败';
      });
    } finally {
      updateUi(draft => {
        draft.profilesLoading = false;
      });
    }
  };

  const loadCodexModels = async () => {
    updateUi(draft => {
      draft.codexModelsLoading = true;
      draft.codexModelsError = '';
    });
    try {
      const result = await systemApi.getCodexModels();
      updateUi(draft => {
        draft.codexModels = Array.isArray(result?.data) ? result.data : [];
      });
    } catch (err) {
      updateUi(draft => {
        draft.codexModels = [];
        draft.codexModelsError = err.message || '读取 Codex 模型列表失败';
      });
    } finally {
      updateUi(draft => {
        draft.codexModelsLoading = false;
      });
    }
  };

  const handleSyncCodexProjects = async () => {
    updateUi(draft => {
      draft.syncing = true;
      draft.syncResult = null;
    });
    try {
      const result = await projectsApi.syncCodexProjects();
      updateUi(draft => {
        draft.syncResult = result;
      });
      await refreshData(['projects', 'issues']);
    } catch (err) {
      updateUi(draft => {
        draft.syncResult = { error: err.message || '同步 Codex 项目失败' };
      });
    } finally {
      updateUi(draft => {
        draft.syncing = false;
      });
    }
  };

  const handleOpenCreateModal = () => {
    updateUi(draft => {
      draft.modalMode = 'create';
      draft.selectedProjectId = null;
      draft.formCwd = '';
      draft.formProvider = DEFAULT_PROVIDER;
      draft.formProviderConfig = '{}';
      draft.formPiManaged = true;
      draft.formModel = DEFAULT_CODEX_MODEL;
      draft.formApproval = 'never';
      draft.formSandbox = 'workspace-write';
      draft.formServiceTier = '';
      draft.formAgentProfileId = '';
      draft.formError = '';
      draft.isModalOpen = true;
    });
    loadAgentProfiles();
    loadCodexModels();
  };

  const handleOpenEditModal = (proj) => {
    updateUi(draft => {
      draft.modalMode = 'edit';
      draft.selectedProjectId = proj.id;
      draft.formCwd = proj.cwd;
      draft.formProvider = proj.provider;
      draft.formProviderConfig = proj.provider_config_json || '{}';
      draft.formPiManaged = proj.pi_managed === 1;
      draft.formModel = normalizeCodexModel(proj.model);
      draft.formApproval = proj.approval_policy || 'never';
      draft.formSandbox = proj.sandbox || 'workspace-write';
      draft.formServiceTier = proj.default_service_tier || '';
      draft.formAgentProfileId = proj.default_agent_profile_id || '';
      draft.formError = '';
      draft.isModalOpen = true;
    });
    loadAgentProfiles();
    loadCodexModels();
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formCwd.trim()) {
      updateUi(draft => {
        draft.formError = '工作路径(CWD)不能为空';
      });
      return;
    }

    const projectName = projectNameFromPath(formCwd);
    const payload = {
      name: projectName,
      cwd: formCwd,
      provider: formProvider,
      provider_config_json: formProviderConfig,
      model: normalizeCodexModel(formModel),
      approval_policy: formApproval,
      sandbox: formSandbox,
      default_service_tier: formServiceTier,
      default_agent_profile_id: formAgentProfileId,
    };

    try {
      if (modalMode === 'create') {
        const generatedId = projectIdFromPath(formCwd);
        await projectsApi.createProject({ id: generatedId, ...payload, auto_run: 0 });
        if (formPiManaged) await projectsApi.bindProjectToPi(generatedId);
      } else {
        await projectsApi.updateProject(selectedProjectId, payload);
        if (formPiManaged) {
          await projectsApi.bindProjectToPi(selectedProjectId);
        } else {
          await projectsApi.unbindProjectFromPi(selectedProjectId);
        }
      }
      updateUi(draft => {
        draft.isModalOpen = false;
      });
      refreshData(['projects', 'issues']);
    } catch (err) {
      updateUi(draft => {
        draft.formError = err.message || '操作失败';
      });
    }
  };

  const handleProfileSubmit = async (e) => {
    e?.preventDefault?.();
    const payload = agentProfilePayload(profileForm);
    if (!payload.name) {
      updateUi(draft => {
        draft.profileError = 'Profile 名称不能为空';
      });
      return;
    }
    try {
      const exists = profiles.some(profile => profile.id === payload.id);
      const saved = exists
        ? await projectsApi.updateAgentProfile(payload.id, payload)
        : await projectsApi.createAgentProfile(payload);
      updateUi(draft => {
        draft.profileForm = emptyAgentProfileForm();
        draft.formAgentProfileId = saved.id;
      });
      await loadAgentProfiles();
    } catch (err) {
      updateUi(draft => {
        draft.profileError = err.message || '保存 Agent Profile 失败';
      });
    }
  };

  const handleEditProfile = (profile) => {
    updateUi(draft => {
      draft.profileForm = normalizeAgentProfileForm(profile);
      draft.profileError = '';
    });
  };

  const handleResetProfileForm = () => {
    updateUi(draft => {
      draft.profileForm = emptyAgentProfileForm();
      draft.profileError = '';
    });
  };

  const handleDelete = async (id) => {
    if (window.confirm('确定要删除该项目吗？关联的 Issue 也会被删除！')) {
      try {
        await projectsApi.deleteProject(id);
        refreshData(['projects', 'issues']);
      } catch (err) {
        message.error(err.message || '删除失败');
      }
    }
  };

  const handleTogglePiManaged = async (proj) => {
    updateUi(draft => {
      draft.piBindingProjectId = proj.id;
    });
    try {
      if (proj.pi_managed === 1) {
        await projectsApi.unbindProjectFromPi(proj.id);
        message.success('已移除 PI 接管，Issue Loop 保持当前运行状态');
      } else {
        await projectsApi.bindProjectToPi(proj.id);
        message.success('PI 已接管，Issue Loop 已自动启用');
      }
      await refreshData(['projects', 'issues']);
    } catch (err) {
      message.error(err.message || '更新 PI 接管状态失败');
    } finally {
      updateUi(draft => {
        draft.piBindingProjectId = '';
      });
    }
  };

  const handleStartLoop = async (id) => {
    try {
      await projectsApi.startProjectLoop(id);
      refreshData(['projects', 'issues']);
    } catch (err) {
      message.error('启动 Loop 失败: ' + err.message);
    }
  };

  const handleStopLoop = async (id) => {
    try {
      await projectsApi.stopProjectLoop(id);
      refreshData(['projects', 'issues']);
    } catch (err) {
      message.error('停止 Loop 失败: ' + err.message);
    }
  };

  const handleResumeHold = async (id) => {
    updateUi(draft => {
      draft.resumingHoldProjectId = id;
    });
    try {
      await projectsApi.resumeProjectHold(id);
      message.success('项目 hold 已恢复');
    } catch (err) {
      message.error('恢复失败，hold 已保留: ' + err.message);
    } finally {
      updateUi(draft => {
        draft.resumingHoldProjectId = '';
      });
      refreshData(['projects', 'issues']);
    }
  };

  return (
    <div className="projects-page animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '24px', height: '100%', minHeight: 0, flex: 1 }}>
      
      {/* 头部导航/动作栏 */}
      <div className="page-intro" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0, padding: '24px 0 8px 0' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '6px' }}>项目管理</h1>
          <p style={{ color: 'var(--text-muted)' }}>添加项目给 PI 后即进入 Issue Loop 无人值守接管</p>
        </div>
        <div className="page-intro-actions" style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <button className="btn btn-secondary" onClick={handleSyncCodexProjects} disabled={syncing}>
            <RefreshCw size={18} className={syncing ? 'animate-spin' : ''} />
            {syncing ? '正在同步...' : '同步 Codex 项目'}
          </button>
          <button className="btn btn-primary" onClick={handleOpenCreateModal}>
            <FolderPlus size={18} /> 新增监控项目
          </button>
        </div>
      </div>

      {/* 滚动内容区 */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '24px', paddingBottom: '24px' }}>
        {!backendOnline && (
          <div className="glass-card" style={{ borderLeft: '4px solid var(--error)', display: 'flex', gap: '16px', alignItems: 'center', padding: '16px 24px', background: 'var(--error-bg)' }}>
            <AlertCircle color="var(--error)" size={24} style={{ flexShrink: 0 }} />
            <div>
              <h4 style={{ color: 'var(--error)', fontWeight: 600 }}>API 连接错误</h4>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>加载数据失败，请检查当前 Runner 后端服务连接。</p>
            </div>
          </div>
        )}

        {syncResult && (
          <div className="glass-card" style={{
            borderLeft: `4px solid ${syncResult.error ? 'var(--error)' : 'var(--success)'}`,
            display: 'flex',
            gap: '16px',
            alignItems: 'flex-start',
            padding: '16px 24px',
            background: syncResult.error ? 'var(--error-bg)' : 'rgba(16,185,129,0.08)'
          }}>
            {syncResult.error ? (
              <AlertCircle color="var(--error)" size={22} style={{ flexShrink: 0 }} />
            ) : (
              <CheckCircle2 color="var(--success)" size={22} style={{ flexShrink: 0 }} />
            )}
            <div style={{ flex: 1 }}>
              <h4 style={{ color: syncResult.error ? 'var(--error)' : 'var(--success)', fontWeight: 600 }}>
                {syncResult.error ? '同步失败' : 'Codex 项目同步完成'}
              </h4>
              {syncResult.error ? (
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{syncResult.error}</p>
              ) : (
                <>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    新增 {syncResult.summary?.created || 0} 个，已存在 {syncResult.summary?.existing || 0} 个，
                    跳过 {syncResult.summary?.skipped || 0} 个。来源：{syncResult.source}
                  </p>
                  {(syncResult.skipped || []).length > 0 && (
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '6px' }}>
                      跳过示例：{syncResult.skipped.slice(0, 3).map(item => `${item.cwd} (${item.reason})`).join('；')}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* 项目网格卡片 */}
        {projects.length === 0 ? (
          <div className="glass-card" style={{ textAlign: 'center', padding: '80px 40px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
            <Folder size={48} color="var(--text-muted)" style={{ opacity: 0.5 }} />
            <div>
              <h3 style={{ fontSize: '1.2rem', fontWeight: 600, marginBottom: '8px' }}>暂无监控项目</h3>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', maxWidth: '400px' }}>点击右上角的「新增监控项目」按钮，将您的本地项目绝对路径配置进来以供 Codex 扫描执行。</p>
            </div>
            <button className="btn btn-primary" style={{ marginTop: '8px' }} onClick={handleOpenCreateModal}>
              立即添加
            </button>
            <button className="btn btn-secondary" onClick={handleSyncCodexProjects} disabled={syncing}>
              <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />
              {syncing ? '正在同步...' : '从 Codex 同步'}
            </button>
          </div>
        ) : (
          <div className="grid-cols-3 projects-grid">
            {projects.map(proj => {
              const projIssues = issues.filter(i => i.project_id === proj.id);
              const doneCount = projIssues.filter(i => i.status === 'done').length;
              const failedCount = projIssues.filter(i => i.status === 'failed').length;
              const activeCount = projIssues.filter(i => i.status === 'in_progress').length;
              const todoCount = projIssues.filter(i => i.status === 'todo').length;

              const isHeld = Boolean(proj.hold);
              const isPiManaged = proj.pi_managed === 1;
              const isLoopActive = !isHeld && (proj.loop_status === 'running' || proj.auto_run === 1);

              return (
                <div key={proj.id} className="glass-card project-card">
                  
                  {/* 项目基本信息 */}
                  <div className="project-card-header">
                    <div className="project-card-identity">
                      <div className="project-card-icon">
                        <Folder size={16} />
                      </div>
                      <div className="project-card-title">
                        <h3 title={proj.name}>
                          {proj.name}
                        </h3>
                        <code title={proj.cwd}>
                          {compactPath(proj.cwd)}
                        </code>
                      </div>
                    </div>

                    <div className="project-status-pill">
                      <span className={`status-dot ${activeCount > 0 ? 'running' : isLoopActive ? 'active' : 'idle'}`}></span>
                      <span>
                        {isHeld ? 'Hold' : activeCount > 0 ? '运行中' : isLoopActive ? '监听中' : '已暂停'}
                      </span>
                    </div>
                  </div>

                  {/* 队列看板 */}
                  <div className="project-card-stats">
                    <div className="project-card-stat">
                      <span>Todo</span>
                      <strong className="count-todo">{todoCount}</strong>
                    </div>
                    <div className="project-card-stat">
                      <span>运行中</span>
                      <strong className="count-active">{activeCount}</strong>
                    </div>
                    <div className="project-card-stat">
                      <span>已完成</span>
                      <strong className="count-done">{doneCount}</strong>
                    </div>
                    <div className="project-card-stat">
                      <span>失败</span>
                      <strong className="count-failed">{failedCount}</strong>
                    </div>
                  </div>

                  <ProjectHoldNotice
                    hold={proj.hold}
                    onResume={() => handleResumeHold(proj.id)}
                    resuming={resumingHoldProjectId === proj.id}
                  />

                  <details className="project-card-details">
                    <summary>
                      <span>配置详情</span>
                      <span>展开查看低频配置</span>
                    </summary>
                    <div className="project-card-meta">
                      <ProjectMetaRow label="Provider" value={providerLabel(proj.provider)} strong />
                      <ProjectMetaRow label="Capabilities" value={capabilitySummary(proj)} />
                      <ProjectMetaRow label="Agent Profile" value={summarizeAgentProfile(proj.default_agent_profile)} />
                      <ProjectMetaRow label="默认速度" value={serviceTierLabel(proj.default_service_tier)} strong />
                      <ProjectMetaRow label="运行模式" value={isPiManaged ? 'PI 无人值守接管' : 'Issue Loop'} strong />
                    </div>
                  </details>

                  {/* 开关与控制操作 */}
                  <div className="project-card-footer">
                    
                    {/* PI 接管开关：绑定即完整接管，不再暴露细分自动化配置。 */}
                    <div className="project-card-auto">
                      <span>PI 自动接管</span>
                      <label className="switch">
                        <input 
                          type="checkbox" 
                          checked={isPiManaged}
                          disabled={piBindingProjectId === proj.id}
                          onChange={() => handleTogglePiManaged(proj)}
                        />
                        <span className="slider"></span>
                      </label>
                    </div>

                    {/* 核心控制动作 */}
                    <div className="project-card-actions">
                      {!isPiManaged && (isLoopActive ? (
                        <button className="btn btn-secondary btn-danger project-card-loop-btn" onClick={() => handleStopLoop(proj.id)}>
                          <Square size={10} fill="currentColor" /> 暂停监听
                        </button>
                      ) : (
                        <button className="btn btn-secondary btn-success project-card-loop-btn" onClick={() => handleStartLoop(proj.id)}>
                          <Play size={10} fill="currentColor" /> 开启监听
                        </button>
                      ))}
                      <button
                        className="btn btn-secondary project-card-icon-btn"
                        onClick={() => handleOpenEditModal(proj)}
                        aria-label={`编辑 ${proj.name} 配置`}
                        title="设置"
                      >
                        <Settings size={13} />
                      </button>
                      <button
                        className="btn btn-secondary btn-danger project-card-icon-btn project-card-delete-btn"
                        onClick={() => handleDelete(proj.id)}
                        aria-label={`删除 ${proj.name}`}
                        title="删除"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>

                  </div>

                </div>
              );
            })}
          </div>
        )}

      </div>


      {/* 新增/编辑项目模态窗 */}
      {isModalOpen && (
        <div className="modal-overlay">
          <div className="glass-card modal-content project-config-modal">
            <div className="project-config-modal-header">
              <h2 style={{ fontSize: '1.4rem', fontWeight: 700 }}>
                {modalMode === 'create' ? '新增监控项目' : '编辑项目配置'}
              </h2>
              <button
                type="button"
                style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)' }}
                onClick={closeModal}
              >
                <X size={20} />
              </button>
            </div>

            <form className="project-config-modal-form" onSubmit={handleSubmit}>
              <div className="project-config-modal-body">
              {formError && (
                <div style={{ color: 'var(--error)', background: 'var(--error-bg)', border: '1px solid rgba(244,63,94,0.2)', padding: '10px 14px', borderRadius: '8px', fontSize: '0.85rem' }}>
                  {formError}
                </div>
              )}

              <div className="form-group">
                <label>项目绝对路径 (CWD) *</label>
                <input 
                  type="text" 
                  className="form-control" 
                  placeholder="/Users/username/projects/project-name"
                  value={formCwd}
                  onChange={(e) => setFormField('formCwd', e.target.value)}
                  required 
                />
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  展示名会自动使用路径最后一级：{formCwd.trim() ? projectNameFromPath(formCwd) : '—'}
                </span>
              </div>

              <div className="form-group">
                <label>Provider</label>
                <select
                  className="form-control"
                  value={formProvider}
                  onChange={(e) => setFormField('formProvider', e.target.value)}
                >
                  {PROVIDER_OPTIONS.map(option => (
                    <option key={option.value} value={option.value} disabled={!option.enabled}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  capability 摘要会随项目 API 返回；execution-only provider 不会进入 Sessions。
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px' }}>
                <div className="form-group">
                  <label>Codex 执行模型</label>
                  {codexModelsError ? (
                    <input
                      className="form-control"
                      value={formModel}
                      onChange={(e) => setFormField('formModel', e.target.value)}
                      placeholder="模型 API 失败，请手动填写 model ID"
                    />
                  ) : (
                    <select
                      className="form-control"
                      disabled={codexModelsLoading}
                      value={formModel}
                      onChange={(e) => setFormField('formModel', e.target.value)}
                    >
                      {codexModelOptions.map(option => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  )}
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    {codexModelsLoading
                      ? '正在读取 Codex 模型列表…'
                      : codexModelsError
                        ? `远端 model API 读取失败，已启用手填：${codexModelsError}`
                        : '模型列表来自当前 Codex provider。'}
                  </span>
                </div>

                <div className="form-group">
                  <label>默认执行速度</label>
                  <select
                    className="form-control"
                    value={formServiceTier}
                    onChange={(e) => setFormField('formServiceTier', e.target.value)}
                  >
                    {serviceTierOptions(formServiceTier).map(option => (
                      <option key={option.value || 'standard'} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px' }}>
                <div className="form-group">
                  <label>审批策略 (Approval)</label>
                  <select 
                    className="form-control" 
                    value={formApproval}
                    onChange={(e) => setFormField('formApproval', e.target.value)}
                  >
                    <option value="never">从不审核 (自动运行)</option>
                    <option value="always">每次执行必审</option>
                    <option value="danger-only">敏感操作时审核</option>
                  </select>
                </div>

                <div className="form-group">
                  <label>沙箱策略 (Sandbox)</label>
                  <select 
                    className="form-control" 
                    value={formSandbox}
                    onChange={(e) => setFormField('formSandbox', e.target.value)}
                  >
                    <option value="workspace-write">仅允许修改当前项目目录 (推荐)</option>
                    <option value="danger-full-access">全系统读写访问 (危险)</option>
                    <option value="read-only">严格只读</option>
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label>默认 Agent Profile v0</label>
                <select
                  className="form-control"
                  value={formAgentProfileId}
                  onChange={(e) => setFormField('formAgentProfileId', e.target.value)}
                >
                  <option value="">不使用 Profile（沿用上方项目参数）</option>
                  {profiles.map(profile => (
                    <option key={profile.id} value={profile.id}>{profile.name} · {profile.id}</option>
                  ))}
                </select>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Profile 会在 issue prompt 中注入默认 instructions 与 skill/plugin intent；不会安装插件或放大权限。
                </span>
              </div>

              <AgentProfileManager
                profiles={profiles}
                loading={profilesLoading}
                form={profileForm}
                error={profileError}
                modelOptions={codexModelOptions}
                modelsError={codexModelsError}
                modelsLoading={codexModelsLoading}
                onFieldChange={setProfileFormField}
                onSubmit={handleProfileSubmit}
                onEdit={handleEditProfile}
                onReset={handleResetProfileForm}
              />

              <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px' }}>
                <label className="switch">
                  <input
                    type="checkbox" 
                    checked={formPiManaged}
                    onChange={(e) => setFormField('formPiManaged', e.target.checked)}
                  />
                  <span className="slider"></span>
                </label>
                <div>
                  <span style={{ fontSize: '0.9rem', fontWeight: 600, display: 'block' }}>由 PI 无人值守接管</span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>绑定后自动启用 Issue Loop；无需再配置 triage、enqueue 或运行模式。</span>
                </div>
              </div>
              </div>

              <div className="project-config-modal-footer">
                <button type="button" className="btn btn-secondary" onClick={closeModal}>
                  取消
                </button>
                <button type="submit" className="btn btn-primary">
                  {modalMode === 'create' ? (formPiManaged ? '创建并交给 PI' : '创建项目') : '保存修改'}
                </button>
              </div>

            </form>

          </div>
        </div>
      )}

    </div>
  );
}

function ProjectMetaRow({ label, value, strong = false }) {
  const ValueTag = strong ? 'strong' : 'span';
  return (
    <div className="project-card-meta-row">
      <span>{label}</span>
      <ValueTag title={value}>{value}</ValueTag>
    </div>
  );
}

function AgentProfileManager({ profiles, loading, form, error, modelOptions, modelsError, modelsLoading, onFieldChange, onSubmit, onEdit, onReset }) {
  return (
    <div className="glass-card" style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px', background: 'rgba(0,0,0,0.025)' }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>Agent Profile v0</div>
        <p style={{ margin: '4px 0 0', color: 'var(--text-muted)', fontSize: '0.75rem' }}>
          仅保存 provider/model/权限 preset、默认 instructions 与 skill/plugin intent；不安装插件、不提升权限。
        </p>
      </div>
      {error && <div style={{ color: 'var(--error)', fontSize: '0.8rem' }}>{error}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px' }}>
          <select className="form-control" value={form.provider} onChange={(e) => onFieldChange('provider', e.target.value)}>
            {PROVIDER_OPTIONS.map(option => (
              <option key={option.value} value={option.value} disabled={!option.enabled}>
                {option.label}
              </option>
            ))}
          </select>
          <input className="form-control" placeholder="Profile ID（可留空自动生成）" value={form.id} onChange={(e) => onFieldChange('id', e.target.value)} />
          <input className="form-control" placeholder="Profile 名称" value={form.name} onChange={(e) => onFieldChange('name', e.target.value)} />
          {modelsError ? (
            <input className="form-control" placeholder="模型 API 失败，请手动填写 model ID" value={form.model} onChange={(e) => onFieldChange('model', e.target.value)} />
          ) : (
            <select className="form-control" disabled={modelsLoading} value={form.model} onChange={(e) => onFieldChange('model', e.target.value)}>
              {modelOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          )}
          <select className="form-control" value={form.reasoning_effort} onChange={(e) => onFieldChange('reasoning_effort', e.target.value)}>
            <option value="">默认 effort</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
          </select>
          <select className="form-control" value={form.service_tier} onChange={(e) => onFieldChange('service_tier', e.target.value)}>
            {serviceTierOptions(form.service_tier).map(option => (
              <option key={option.value || 'standard'} value={option.value}>速度：{option.label}</option>
            ))}
          </select>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px' }}>
          <select className="form-control" value={form.approval_policy} onChange={(e) => onFieldChange('approval_policy', e.target.value)}>
            <option value="">沿用项目 approval</option>
            <option value="never">never</option>
            <option value="always">always</option>
            <option value="danger-only">danger-only</option>
          </select>
          <select className="form-control" value={form.sandbox} onChange={(e) => onFieldChange('sandbox', e.target.value)}>
            <option value="">沿用项目 sandbox</option>
            <option value="workspace-write">workspace-write</option>
            <option value="read-only">read-only</option>
            <option value="danger-full-access">danger-full-access</option>
          </select>
        </div>
        <textarea className="form-control" rows={3} placeholder="默认 instructions" value={form.default_instructions} onChange={(e) => onFieldChange('default_instructions', e.target.value)} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px' }}>
          <input className="form-control" placeholder="skill intents，逗号分隔" value={form.skill_intents} onChange={(e) => onFieldChange('skill_intents', e.target.value)} />
          <input className="form-control" placeholder="plugin intents，逗号分隔" value={form.plugin_intents} onChange={(e) => onFieldChange('plugin_intents', e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>{loading ? '加载 profiles...' : `已有 ${profiles.length} 个 profile`}</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" className="btn btn-secondary" style={{ padding: '6px 10px', fontSize: '0.75rem' }} onClick={onReset}>清空</button>
            <button type="button" className="btn btn-secondary" style={{ padding: '6px 10px', fontSize: '0.75rem' }} onClick={onSubmit}>保存 Profile</button>
          </div>
        </div>
      </div>
      {profiles.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {profiles.map(profile => (
            <button key={profile.id} type="button" className="kanban-card-action-btn" onClick={() => onEdit(profile)}>
              {profile.name} · {profile.id}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
