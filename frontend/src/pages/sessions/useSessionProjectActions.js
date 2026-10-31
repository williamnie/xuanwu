import { sessionSettingsForProject, sessionSettingsForProvider } from './sessionOptions';
import { useCallback } from 'react';
import { orderedProjectsAfterMove } from './projectOrder';
import { projectsApi } from '../../api/projects.js';
import { message as toast } from '../../store/toastStore';

export default function useSessionProjectActions({
  sessionProjects,
  setProjectId,
  setCwd,
  cwd,
  setSessionSettings,
  providerSelectionTouchedRef,
  projects,
  setSavingProjectOrder,
  setProjects,
  setMessageSettings,
}) {
  const handleProjectChange = (id) => {
    const project = sessionProjects.find((item) => item.id === id) || null;
    setProjectId(id);
    setCwd(project?.cwd || cwd);
    setSessionSettings((current) => sessionSettingsForProject(
      project,
      current,
      providerSelectionTouchedRef.current,
    ));
  };

  const handleReorderProjects = useCallback(async (sourceId, targetId) => {
    const nextProjects = orderedProjectsAfterMove(projects, sourceId, targetId);
    if (nextProjects === projects) return;

    setSavingProjectOrder(true);
    setProjects(nextProjects);
    try {
      const updated = await projectsApi.reorderProjects(nextProjects.map((project) => project.id));
      setProjects(updated || nextProjects);
    } catch (err) {
      setProjects(projects);
      toast.error(err.message || '保存项目顺序失败');
    } finally {
      setSavingProjectOrder(false);
    }
  }, [projects, setProjects, setSavingProjectOrder]);

  const handleSettingChange = (field, value) => {
    if (field === 'provider') providerSelectionTouchedRef.current = true;
    setSessionSettings((current) => field === 'provider'
      ? sessionSettingsForProvider(current, value)
      : { ...current, [field]: value });
  };

  const handleMessageSettingChange = (field, value) => {
    setMessageSettings((current) => ({ ...current, [field]: value }));
  };

  return { handleProjectChange, handleReorderProjects, handleSettingChange, handleMessageSettingChange };
}
