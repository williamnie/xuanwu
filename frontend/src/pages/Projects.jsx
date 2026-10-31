import { useProjectNodes } from '../store/useProjectNodes.js';
import { selectBackendOnline, selectProjects, selectRefreshData, selectWorkSummary, useDataStore } from '../store/dataStore';
import { FolderPlus, Folder, RefreshCw, CheckCircle2, Trash2, X, AlertCircle } from 'lucide-react';
// 保持拆分前的样式级联：远程标记 → 项目页面 → 卡片提示 → 编辑器。
import '../components/RemoteProjectBadge.css';
import './Projects.css';
import ProjectCard from './projects/ProjectCard.jsx';
import ProjectSettingsEditor from './ProjectSettingsEditor';
import ModalOverlay from '../components/ModalOverlay.jsx';
import { codexImportNote, codexImportVisible, useCodexImportPreview } from './codexImportPreview.js';
import useProjectsActions from './projects/useProjectsActions.js';

export default function Projects() {
  const nodesById = useProjectNodes();
  const projects = useDataStore(selectProjects);
  const workSummary = useDataStore(selectWorkSummary);
  const backendOnline = useDataStore(selectBackendOnline);
  const refreshData = useDataStore(selectRefreshData);
  const [codexImport, refreshCodexImport] = useCodexImportPreview();
  const showCodexImport = codexImportVisible(codexImport);
  const {
    syncing, syncResult, modalMode, selectedProjectId, selectedProject,
    deleteProject, deleteProjectIssueCount, deletingProjectId, resumingHoldProjectId, closeModal,
    handleSyncCodexProjects, handleOpenCreateModal, handleOpenEditModal, handleOpenDeleteModal, closeDeleteModal,
    handleDelete, handleResumeHold,
  } = useProjectsActions({ projects, workSummary, refreshData, refreshCodexImport });

  return (
    <section className="glass-card settings-project-panel">
      <div className="settings-project-panel-header">
        <p className="settings-project-panel-note">开启自动执行后，玄武会依次处理项目中排队的任务。{showCodexImport ? `“从 Codex 导入”：${codexImportNote(codexImport)}` : ''}</p>
        <div className="settings-project-panel-actions">
          {showCodexImport ? (
            <button className="btn btn-secondary" onClick={handleSyncCodexProjects} disabled={syncing} type="button">
              <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />
              {syncing ? '正在导入…' : '从 Codex 导入'}
            </button>
          ) : null}
          <button className="btn btn-primary" onClick={handleOpenCreateModal} type="button">
            <FolderPlus size={16} /> 添加项目
          </button>
        </div>
      </div>

      <div className="settings-project-panel-body">
        {!backendOnline && (
          <div className="glass-card projects-notice is-error">
            <AlertCircle className="projects-notice-icon" color="var(--error)" size={16} />
            <div>
              <h4 className="projects-notice-title">API 连接错误</h4>
              <p className="projects-notice-copy">加载数据失败，请检查当前 Runner 后端服务连接。</p>
            </div>
          </div>
        )}

        {syncResult && (
          <div className={`glass-card projects-notice ${syncResult.error ? 'is-error' : 'is-success'}`}>
            {syncResult.error ? (
              <AlertCircle className="projects-notice-icon" color="var(--error)" size={16} />
            ) : (
              <CheckCircle2 className="projects-notice-icon" color="var(--success)" size={16} />
            )}
            <div className="projects-notice-body">
              <h4 className="projects-notice-title">
                {syncResult.error ? '同步失败' : 'Codex 项目同步完成'}
              </h4>
              {syncResult.error ? (
                <p className="projects-notice-copy">{syncResult.error}</p>
              ) : (
                <>
                  <p className="projects-notice-copy">
                    新增 {syncResult.summary?.created || 0} 个，已存在 {syncResult.summary?.existing || 0} 个，
                    跳过 {syncResult.summary?.skipped || 0} 个。来源：{syncResult.source}
                  </p>
                  {(syncResult.skipped || []).length > 0 && (
                    <p className="projects-notice-detail">
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
          <div className="glass-card projects-empty">
            <Folder className="projects-empty-icon" size={34} color="var(--text-muted)" />
            <div>
              <h3 className="projects-empty-title">暂无监控项目</h3>
              <p className="projects-empty-copy">{showCodexImport ? '添加本地项目路径，或从已有 Codex 项目中导入。' : '添加本地项目路径。'}</p>
            </div>
            <button className="btn btn-secondary projects-empty-primary" onClick={handleOpenCreateModal}>
              添加项目
            </button>
            {showCodexImport ? (
              <button className="btn btn-secondary" onClick={handleSyncCodexProjects} disabled={syncing} type="button">
                <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />
                {syncing ? '正在导入…' : '从 Codex 导入'}
              </button>
            ) : null}
          </div>
        ) : (
          <div className="grid-cols-3 projects-grid">
            {projects.map(proj => (
              <ProjectCard key={proj.id} proj={proj}
                counts={workSummary.project_counts?.find(item => item.project_id === proj.id)?.counts || {}}
                nodesById={nodesById} handleResumeHold={handleResumeHold}
                resumingHoldProjectId={resumingHoldProjectId}
                handleOpenEditModal={handleOpenEditModal} handleOpenDeleteModal={handleOpenDeleteModal} />
            ))}
          </div>
        )}

      </div>


      {modalMode && (modalMode === 'create' || selectedProject) && (
        <ModalOverlay className="project-modal-overlay">
          <div className={`modal-content project-config-modal project-config-modal-${modalMode}`}>
            <div className="project-config-modal-header">
              <div>
                <h2>{modalMode === 'create' ? '添加项目' : `编辑 ${selectedProject.name}`}</h2>
                <p>{modalMode === 'create' ? '只需填写项目路径；不确定的选项保持默认即可。' : '修改这个项目的默认运行设置。'}</p>
              </div>
              <button
                aria-label={modalMode === 'create' ? '关闭添加项目' : '关闭编辑项目'}
                className="project-config-modal-close"
                onClick={closeModal}
                type="button"
              >
                <X size={16} />
              </button>
            </div>
            <ProjectSettingsEditor
              key={selectedProjectId || 'create'}
              layout="modal"
              mode={modalMode}
              onCancel={closeModal}
              onSaved={async () => {
                closeModal();
                await refreshData(['projects', 'workSummary']);
              }}
              project={selectedProject}
            />
          </div>
        </ModalOverlay>
      )}

      {deleteProject && (
        <ModalOverlay className="project-modal-overlay">
          <div
            aria-describedby="project-delete-dialog-description"
            aria-labelledby="project-delete-dialog-title"
            aria-modal="true"
            className="modal-content project-delete-modal"
            role="alertdialog"
          >
            <div className="project-delete-modal-header">
              <div className="project-delete-modal-icon" aria-hidden="true">
                <Trash2 size={16} />
              </div>
              <div>
                <div className="project-delete-modal-eyebrow">危险操作</div>
                <h2 id="project-delete-dialog-title">删除 {deleteProject.name}？</h2>
                <p id="project-delete-dialog-description">
                  将同时删除 {deleteProjectIssueCount} 个关联 Issue，且无法从界面恢复。
                </p>
              </div>
            </div>

            <div className="project-delete-modal-project">
              <span>项目路径</span>
              <code>{deleteProject.node_id ? `${nodesById.get(deleteProject.node_id)?.name || deleteProject.node_id}:${deleteProject.node_path}` : deleteProject.cwd}</code>
            </div>

            <div className="project-delete-modal-actions">
              <button
                className="btn btn-secondary"
                disabled={Boolean(deletingProjectId)}
                onClick={closeDeleteModal}
                type="button"
              >
                取消
              </button>
              <button
                className="btn project-delete-confirm-button"
                disabled={Boolean(deletingProjectId)}
                onClick={handleDelete}
                type="button"
              >
                <Trash2 size={14} />
                {deletingProjectId ? '正在删除…' : '确认删除'}
              </button>
            </div>
          </div>
        </ModalOverlay>
      )}
    </section>
  );
}
