import { projectsApi } from '../../api/projects.js';
import { useImmer } from 'use-immer';
import { message } from '../../store/toastStore';

export default function useProjectsActions({ projects, workSummary, refreshData, refreshCodexImport }) {
  const [ui, updateUi] = useImmer({
    syncing: false,
    syncResult: null,
    modalMode: '',
    deleteProjectId: '',
    deletingProjectId: '',
    resumingHoldProjectId: '',
    selectedProjectId: '',
  });

  const {
    syncing,
    syncResult,
    modalMode,
    deleteProjectId,
    deletingProjectId,
    resumingHoldProjectId,
    selectedProjectId,
  } = ui;
  const selectedProject = projects.find(project => project.id === selectedProjectId) || null;
  const deleteProject = projects.find(project => project.id === deleteProjectId) || null;
  const deleteProjectIssueCount = deleteProject
    ? workSummary.project_counts?.find(item => item.project_id === deleteProject.id)?.counts?.total || 0
    : 0;

  const closeModal = () => {
    updateUi(draft => {
      draft.modalMode = '';
      draft.selectedProjectId = '';
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
      await Promise.all([refreshData(['projects', 'workSummary']), refreshCodexImport()]);
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
      draft.selectedProjectId = '';
    });
  };

  const handleOpenEditModal = (project) => {
    updateUi(draft => {
      draft.modalMode = 'edit';
      draft.selectedProjectId = project.id;
    });
  };

  const handleOpenDeleteModal = (project) => {
    updateUi(draft => {
      draft.deleteProjectId = project.id;
    });
  };

  const closeDeleteModal = () => {
    if (deletingProjectId) return;
    updateUi(draft => {
      draft.deleteProjectId = '';
    });
  };

  const handleDelete = async () => {
    if (!deleteProject || deletingProjectId) return;
    const projectToDelete = deleteProject;

    updateUi(draft => {
      draft.deletingProjectId = projectToDelete.id;
    });
    try {
      await projectsApi.deleteProject(projectToDelete.id);
      updateUi(draft => {
        draft.deleteProjectId = '';
      });
      message.success(`项目 ${projectToDelete.name} 已删除`);
      await refreshData(['projects', 'workSummary']);
    } catch (err) {
      message.error(err.message || '删除失败');
    } finally {
      updateUi(draft => {
        draft.deletingProjectId = '';
      });
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
      refreshData(['projects', 'workSummary']);
    }
  };

  return {
    syncing, syncResult, modalMode, selectedProjectId, selectedProject,
    deleteProject, deleteProjectIssueCount, deletingProjectId, resumingHoldProjectId, closeModal,
    handleSyncCodexProjects, handleOpenCreateModal, handleOpenEditModal, handleOpenDeleteModal, closeDeleteModal,
    handleDelete, handleResumeHold,
  };
}
