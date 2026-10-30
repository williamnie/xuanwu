

import { firstDeliveryApi } from '../../api/firstDelivery.js';

import { projectsApi } from '../../api/projects.js';
import { systemApi } from '../../api/system.js';
import { workApi } from '../../api/work.js';

import { message } from '../../store/toastStore.js';
import { codexBackendUpdatePayload } from '../../utils/codexBackends.js';

import { FIRST_DELIVERY_TITLE, RUNTIME_REPAIR_COMMAND, sampleWorkPayload } from './firstDeliveryGuideModel.js';
import { codexImportFailure } from './firstDeliverySetup.js';

export function useFirstDeliveryActions({
    setSnapshot, setBusy, setError, setSelectedCodeAgentID, selectedCodeAgentID,
    selectedProject, state, projects, refreshData, setSelectedProjectID,
    setProjectConfirmed, validPath, pathResult, cwd, refreshCodexImport,
    selectedProjectID, targetWorkRef, onOpenWork, setCreationNeedsRefresh, recovery,
}) {
  const updateCodeAgents = (response) => {
    const codeAgents = Array.isArray(response?.agents) ? response.agents : [];
    setSnapshot(current => ({ ...current, codeAgents }));
    return codeAgents;
  };

  const selectCodeAgent = async (agent) => {
    if (agent.enabled && !agent.submittable) return setError(agent.readiness_reason || `${agent.label || agent.id} 尚未就绪`);
    setBusy(`agent:${agent.id}`);
    setError('');
    try {
      let enabled = agent;
      if (!agent.enabled) {
        const agents = updateCodeAgents(await systemApi.updateCodeAgent(agent.id, true));
        enabled = agents.find(item => item.id === agent.id);
      }
      if (!enabled?.submittable) return setError(enabled?.readiness_reason || `${enabled?.label || agent.id} 已启用，但尚未就绪`);
      setSelectedCodeAgentID(agent.id);
      message.success(`${enabled.label || agent.id} 已选中，确认项目后绑定`);
    } catch (agentError) {
      setError(agentError.message || '启用编程工具失败');
    } finally {
      setBusy('');
    }
  };

  const discoverCodeAgents = async () => {
    setBusy('agent:discover');
    setError('');
    try {
      const agents = updateCodeAgents(await systemApi.discoverCodeAgents());
      if (selectedCodeAgentID && !agents.some(agent => agent.id === selectedCodeAgentID && agent.enabled && agent.submittable)) {
        setSelectedCodeAgentID('');
      }
    } catch (agentError) {
      setError(agentError.message || '重新发现编程工具失败');
    } finally {
      setBusy('');
    }
  };

  const selectCodexBackend = async (mode) => {
    setBusy('agent:codex-backend');
    setError('');
    try {
      const runnerSettings = await systemApi.updateRunnerSettings(codexBackendUpdatePayload(mode));
      const agents = updateCodeAgents(await systemApi.discoverCodeAgents());
      setSnapshot(current => ({ ...current, runnerSettings }));
      if (agents.some(agent => agent.id === 'codex' && agent.enabled && agent.submittable)) {
        setSelectedCodeAgentID('codex');
      } else setSelectedCodeAgentID('');
      if (runnerSettings?.runtime_apply?.codexTransport === 'deferred_active_sessions') {
        message.warning('Codex 后端已保存；当前执行记录结束或服务重启后生效');
      } else {
        message.success(`新的 Codex 任务将使用 ${mode === 'app' ? 'Codex App' : 'Codex CLI'}`);
      }
    } catch (agentError) {
      setError(agentError.message || '切换 Codex 后端失败');
    } finally {
      setBusy('');
    }
  };

  const confirmProject = async (project = selectedProject) => {
    if (!project || !state.selectedCodeAgent) return;
    setBusy('project');
    setError('');
    try {
      // Preselection is local; only this explicit confirmation binds the tool.
      if (project.provider !== state.selectedCodeAgent.id) {
        await projectsApi.updateProject(project.id, {
          default_agent_profile_id: '',
          model: state.selectedCodeAgent.id === 'codex' ? 'codex-default' : '',
          provider: state.selectedCodeAgent.id,
        });
      }
      if (project.provider !== state.selectedCodeAgent.id || !projects.some(item => item.id === project.id)) {
        await refreshData(['projects', 'workSummary']);
      }
      setSelectedProjectID(project.id);
      setProjectConfirmed(true);
    } catch (failure) {
      setError(failure.message || '项目绑定失败，请重试');
    } finally { setBusy(''); }
  };

  const createProject = async (event) => {
    event.preventDefault();
    if (!validPath) return setError('请等待项目路径检查通过');
    if (!state.selectedCodeAgent) return setError('请先选择可用的编程工具');
    setBusy('project');
    setError('');
    try {
      if (pathResult.existing_project_id) {
        const existing = projects.find(project => project.id === pathResult.existing_project_id)
          || await projectsApi.getProject(pathResult.existing_project_id);
        return await confirmProject(existing);
      }
      const provider = state.selectedCodeAgent.id;
      const path = cwd.trim();
      const created = await projectsApi.createProject({
        approval_policy: 'never',
        auto_run: 1,
        cwd: path,
        id: pathResult.suggested_id,
        model: provider === 'codex' ? 'codex-default' : '',
        name: path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || pathResult.suggested_id,
        provider,
        sandbox: 'workspace-write',
      });
      await refreshData(['projects', 'workSummary']);
      setSelectedProjectID(created.id);
      setProjectConfirmed(true);
      message.success(`项目已添加，并绑定 ${state.selectedCodeAgent.label || provider}`);
    } catch (createError) {
      setError(createError.message || '添加项目失败');
    } finally { setBusy(''); }
  };

  const importCodex = async () => {
    setBusy('import');
    setError('');
    try {
      const result = await projectsApi.syncCodexProjects();
      await Promise.all([refreshData(['projects', 'workSummary']), refreshCodexImport()]);
      const project = result.created?.[0] || result.existing?.[0];
      if (project) setSelectedProjectID(project.id);
      message.success(project ? '工作区已导入，请确认要使用的项目' : '没有可导入的本机工作区，请直接输入项目路径');
    } catch (failure) { setError(codexImportFailure(failure)); }
    finally { setBusy(''); }
  };

  const createSampleWork = async () => {
    const project = projects.find(item => item.id === selectedProjectID) || projects[0];
    if (!project) return setError('请先添加项目');
    setBusy('work');
    setError('');
    try {
      const authority = await workApi.getWorks({
        pageSize: 10,
        projectId: project.id,
        query: FIRST_DELIVERY_TITLE,
      });
      const existing = (authority?.items || []).find(work => work?.title === FIRST_DELIVERY_TITLE);
      const created = existing || await workApi.createWork(sampleWorkPayload(project.id));
      targetWorkRef.current = created?.work?.id || created?.id || existing?.id || '';
      await firstDeliveryApi.startProjectLoop(project.id);
      message.success(existing ? '已恢复现有示例任务' : '示例任务已创建并开始');
      await refreshData(['projects', 'workSummary']);
      if (!targetWorkRef.current) throw new Error('未能读取示例任务，请重新检查');
      onOpenWork(targetWorkRef.current);
    } catch (createError) {
      setCreationNeedsRefresh(true);
      setError(`${createError.message || '创建示例任务失败'}。为避免重复创建，请先重新检查。`);
    } finally {
      setBusy('');
    }
  };

  const copyRecovery = async () => {
    try {
      await navigator.clipboard.writeText(!state.runtimeReady ? RUNTIME_REPAIR_COMMAND : recovery);
      message.success('恢复步骤已复制');
    } catch (copyError) {
      setError(copyError.message || '复制失败，请手动选中恢复步骤');
    }
  };

  return { selectCodeAgent, discoverCodeAgents, selectCodexBackend, confirmProject, createProject, importCodex, createSampleWork, copyRecovery };
}
