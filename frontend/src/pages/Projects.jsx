import { useImmer } from 'use-immer';
import { api } from '../api/client';
import { message } from '../store/toastStore';
import {
  selectBackendOnline,
  selectIssues,
  selectProjects,
  selectRefreshAllData,
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

const DEFAULT_PROJECT_NAME = 'project';
const DEFAULT_CODEX_MODEL = 'codex-default';
const DEFAULT_PROVIDER = 'codex';

const CODEX_MODEL_OPTIONS = [
  { value: DEFAULT_CODEX_MODEL, label: '系统默认模型' },
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
  { value: 'gpt-5.2', label: 'GPT-5.2' },
];

function projectNameFromPath(cwd) {
  const trimmed = cwd.trim().replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).pop() || DEFAULT_PROJECT_NAME;
}

function projectIdFromPath(cwd) {
  const base = projectNameFromPath(cwd).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return base.replace(/^-+|-+$/g, '') || DEFAULT_PROJECT_NAME;
}

function normalizeCodexModel(model) {
  if (!CODEX_MODEL_OPTIONS.some(option => option.value === model)) {
    return DEFAULT_CODEX_MODEL;
  }
  return model;
}

export default function Projects() {
  const projects = useDataStore(selectProjects);
  const issues = useDataStore(selectIssues);
  const backendOnline = useDataStore(selectBackendOnline);
  const refreshAllData = useDataStore(selectRefreshAllData);
  const [ui, updateUi] = useImmer({
    syncing: false,
    syncResult: null,
    isModalOpen: false,
    modalMode: 'create', // 'create' | 'edit'
    selectedProjectId: null,
    formCwd: '',
    formProvider: DEFAULT_PROVIDER,
    formProviderConfig: '{}',
    formAutoRun: false,
    formModel: DEFAULT_CODEX_MODEL,
    formApproval: 'never',
    formSandbox: 'workspace-write',
    formError: '',
    resumingHoldProjectId: '',
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
    formAutoRun,
    formModel,
    formApproval,
    formSandbox,
    formError,
    resumingHoldProjectId,
  } = ui;

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

  const handleSyncCodexProjects = async () => {
    updateUi(draft => {
      draft.syncing = true;
      draft.syncResult = null;
    });
    try {
      const result = await api.syncCodexProjects();
      updateUi(draft => {
        draft.syncResult = result;
      });
      await refreshAllData();
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
      draft.formAutoRun = false;
      draft.formModel = DEFAULT_CODEX_MODEL;
      draft.formApproval = 'never';
      draft.formSandbox = 'workspace-write';
      draft.formError = '';
      draft.isModalOpen = true;
    });
  };

  const handleOpenEditModal = (proj) => {
    updateUi(draft => {
      draft.modalMode = 'edit';
      draft.selectedProjectId = proj.id;
      draft.formCwd = proj.cwd;
      draft.formProvider = proj.provider;
      draft.formProviderConfig = proj.provider_config_json || '{}';
      draft.formAutoRun = proj.auto_run === 1;
      draft.formModel = normalizeCodexModel(proj.model || DEFAULT_CODEX_MODEL);
      draft.formApproval = proj.approval_policy || 'never';
      draft.formSandbox = proj.sandbox || 'workspace-write';
      draft.formError = '';
      draft.isModalOpen = true;
    });
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
      auto_run: formAutoRun ? 1 : 0,
      model: normalizeCodexModel(formModel),
      approval_policy: formApproval,
      sandbox: formSandbox,
    };

    try {
      if (modalMode === 'create') {
        const generatedId = projectIdFromPath(formCwd);
        await api.createProject({ id: generatedId, ...payload });
      } else {
        await api.updateProject(selectedProjectId, payload);
      }
      updateUi(draft => {
        draft.isModalOpen = false;
      });
      refreshAllData();
    } catch (err) {
      updateUi(draft => {
        draft.formError = err.message || '操作失败';
      });
    }
  };

  const handleDelete = async (id) => {
    if (window.confirm('确定要删除该项目吗？关联的 Issue 也会被删除！')) {
      try {
        await api.deleteProject(id);
        refreshAllData();
      } catch (err) {
        message.error(err.message || '删除失败');
      }
    }
  };

  const handleToggleAutoRun = async (proj) => {
    const nextAutoRun = proj.auto_run === 1 ? 0 : 1;
    try {
      await api.updateProject(proj.id, { auto_run: nextAutoRun });
      refreshAllData();
    } catch {
      message.error('更新自动执行配置失败');
    }
  };

  const handleStartLoop = async (id) => {
    try {
      await api.startProjectLoop(id);
      refreshAllData();
    } catch (err) {
      message.error('启动 Loop 失败: ' + err.message);
    }
  };

  const handleStopLoop = async (id) => {
    try {
      await api.stopProjectLoop(id);
      refreshAllData();
    } catch (err) {
      message.error('停止 Loop 失败: ' + err.message);
    }
  };

  const handleResumeHold = async (id) => {
    updateUi(draft => {
      draft.resumingHoldProjectId = id;
    });
    try {
      await api.resumeProjectHold(id);
      message.success('项目 hold 已恢复');
    } catch (err) {
      message.error('恢复失败，hold 已保留: ' + err.message);
    } finally {
      updateUi(draft => {
        draft.resumingHoldProjectId = '';
      });
      refreshAllData();
    }
  };

  return (
    <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '24px', height: '100%', minHeight: 0, flex: 1 }}>
      
      {/* 头部导航/动作栏 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0, padding: '24px 0 8px 0' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '6px' }}>项目管理</h1>
          <p style={{ color: 'var(--text-muted)' }}>管理本地项目代码库，控制 Codex 自动扫描和执行参数</p>
        </div>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
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
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>加载数据失败，请检查 Go 后端服务连接。</p>
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
          <div className="grid-cols-3">
            {projects.map(proj => {
              const projIssues = issues.filter(i => i.project_id === proj.id);
              const doneCount = projIssues.filter(i => i.status === 'done').length;
              const failedCount = projIssues.filter(i => i.status === 'failed').length;
              const activeCount = projIssues.filter(i => i.status === 'in_progress').length;
              const todoCount = projIssues.filter(i => i.status === 'todo').length;

              const isHeld = Boolean(proj.hold);
              const isLoopActive = !isHeld && (proj.loop_status === 'running' || proj.auto_run === 1);

              return (
                <div key={proj.id} className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '14px', padding: '16px' }}>
                  
                  {/* 项目基本信息 */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                      <div style={{ padding: '8px', borderRadius: '8px', background: 'var(--primary-glow)', color: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Folder size={16} />
                      </div>
                      <div>
                        <h3 style={{ fontSize: '0.95rem', fontWeight: 650, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '130px' }} title={proj.name}>
                          {proj.name}
                        </h3>
                        <code style={{ fontSize: '0.68rem', color: 'var(--text-muted)', display: 'block', marginTop: '1px', maxWidth: '130px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={proj.cwd}>
                          {proj.cwd}
                        </code>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span className={`status-dot ${activeCount > 0 ? 'running' : isLoopActive ? 'active' : 'idle'}`} style={{ width: '6px', height: '6px' }}></span>
                      <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                        {isHeld ? 'Hold' : activeCount > 0 ? '运行中' : isLoopActive ? '监听中' : '已暂停'}
                      </span>
                    </div>
                  </div>

                  {/* 队列看板 */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '4px', background: 'rgba(0,0,0,0.04)', padding: '8px 4px', borderRadius: '8px', textAlign: 'center' }}>
                    <div>
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Todo</div>
                      <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--primary)' }}>{todoCount}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>运行中</div>
                      <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--warning)' }}>{activeCount}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>已完成</div>
                      <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--success)' }}>{doneCount}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>失败</div>
                      <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--error)' }}>{failedCount}</div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                    <span>Provider</span>
                    <strong style={{ color: 'var(--text-primary)' }}>{providerLabel(proj.provider)}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                    <span>Capabilities</span>
                    <span style={{ color: 'var(--text-primary)', textAlign: 'right' }}>{capabilitySummary(proj)}</span>
                  </div>

                  <ProjectHoldNotice
                    hold={proj.hold}
                    onResume={() => handleResumeHold(proj.id)}
                    resuming={resumingHoldProjectId === proj.id}
                  />

                  {/* 开关与控制操作 */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', borderTop: '1px solid var(--border-color)', paddingTop: '12px' }}>
                    
                    {/* Auto run 开关 */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <span style={{ fontSize: '0.78rem', fontWeight: 650, display: 'block' }}>自动运行 (Auto Run)</span>
                        <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>有 todo 自动触发</span>
                      </div>
                      <label className="switch">
                        <input 
                          type="checkbox" 
                          checked={proj.auto_run === 1}
                          onChange={() => handleToggleAutoRun(proj)}
                        />
                        <span className="slider"></span>
                      </label>
                    </div>

                    {/* 核心控制动作 */}
                    <div style={{ display: 'flex', gap: '6px', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', gap: '6px', flex: 1 }}>
                        {isLoopActive ? (
                          <button className="btn btn-secondary btn-danger" style={{ padding: '6px 10px', fontSize: '0.75rem', flex: 1, height: '30px' }} onClick={() => handleStopLoop(proj.id)}>
                            <Square size={10} fill="currentColor" /> 暂停监听
                          </button>
                        ) : (
                          <button className="btn btn-secondary btn-success" style={{ padding: '6px 10px', fontSize: '0.75rem', flex: 1, height: '30px' }} onClick={() => handleStartLoop(proj.id)}>
                            <Play size={10} fill="currentColor" /> 开启监听
                          </button>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '8px', width: '30px', height: '30px', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => handleOpenEditModal(proj)}>
                          <Settings size={13} />
                        </button>
                        <button className="btn btn-secondary btn-danger" style={{ padding: '6px', borderRadius: '8px', background: 'transparent', width: '30px', height: '30px', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => handleDelete(proj.id)}>
                          <Trash2 size={13} />
                        </button>
                      </div>
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
          <div className="glass-card modal-content" style={{ padding: '32px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
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

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              
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
                  <select 
                    className="form-control" 
                    value={formModel}
                    onChange={(e) => setFormField('formModel', e.target.value)}
                  >
                    {CODEX_MODEL_OPTIONS.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>

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

              <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px' }}>
                <label className="switch">
                  <input 
                    type="checkbox" 
                    checked={formAutoRun}
                    onChange={(e) => setFormField('formAutoRun', e.target.checked)}
                  />
                  <span className="slider"></span>
                </label>
                <div>
                  <span style={{ fontSize: '0.9rem', fontWeight: 600, display: 'block' }}>保存后立即开启自动运行 (Auto Run)</span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>新 Issue 将会被自动提交给 Codex 执行。</span>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', marginTop: '16px' }}>
                <button type="button" className="btn btn-secondary" onClick={closeModal}>
                  取消
                </button>
                <button type="submit" className="btn btn-primary">
                  {modalMode === 'create' ? '创建并启用' : '保存修改'}
                </button>
              </div>

            </form>

          </div>
        </div>
      )}

    </div>
  );
}
