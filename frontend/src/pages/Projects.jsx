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
  X,
  AlertCircle
} from 'lucide-react';
import ProjectHoldNotice from './ProjectHoldNotice';
import ProjectSettingsEditor from './ProjectSettingsEditor';

function compactPath(cwd = '') {
  const text = String(cwd || '').trim().replace(/[\\/]+$/, '');
  const parts = text.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 3) return text || '—';
  return `…/${parts.slice(-2).join('/')}`;
}

export default function Projects({ onManageProject }) {
  const projects = useDataStore(selectProjects);
  const issues = useDataStore(selectIssues);
  const backendOnline = useDataStore(selectBackendOnline);
  const refreshData = useDataStore(selectRefreshData);
  const [ui, updateUi] = useImmer({
    syncing: false,
    syncResult: null,
    isCreateModalOpen: false,
    resumingHoldProjectId: '',
  });

  const {
    syncing,
    syncResult,
    isCreateModalOpen,
    resumingHoldProjectId,
  } = ui;

  const closeModal = () => {
    updateUi(draft => {
      draft.isCreateModalOpen = false;
    });
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
      draft.isCreateModalOpen = true;
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

                  {/* 项目配置操作 */}
                  <div className="project-card-footer">
                    <div className="project-card-actions">
                      <button
                        className="btn btn-secondary project-card-icon-btn"
                        onClick={() => onManageProject?.(proj.id)}
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


      {/* 新增项目仍属于项目管理；现有项目配置统一在“设置 > 项目”编辑。 */}
      {isCreateModalOpen && (
        <div className="modal-overlay">
          <div className="glass-card modal-content project-config-modal">
            <div className="project-config-modal-header">
              <h2 style={{ fontSize: '1.4rem', fontWeight: 700 }}>新增监控项目</h2>
              <button
                aria-label="关闭新增项目"
                onClick={closeModal}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)' }}
                type="button"
              >
                <X size={20} />
              </button>
            </div>
            <ProjectSettingsEditor
              layout="modal"
              mode="create"
              onCancel={closeModal}
              onSaved={async () => {
                closeModal();
                await refreshData(['projects', 'issues']);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
