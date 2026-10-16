import { useCallback, useEffect, useState } from 'react';
import { projectsApi } from '../api/projects.js';

// “从 Codex 导入”的只读可用性：GET 预览只读取 Codex 工作区记录，不创建项目、不开启自动执行。
// loading 期间先不显示按钮，避免闪现；预览接口本身失败（旧后端 / 网络）时退回始终显示，点击后给出明确结果。
export function codexImportVisible(state) {
  if (state.status === 'error') return true;
  if (state.status !== 'ready') return false;
  const preview = state.preview;
  return Boolean(preview?.available) && (preview.summary.new + preview.summary.existing) > 0;
}

export function codexImportNote(state) {
  const summary = state.status === 'ready' && state.preview?.available ? state.preview.summary : null;
  if (!summary) return '读取本机 Codex Desktop 工作区；会对已有项目开启自动执行。';
  const found = summary.new > 0 ? `发现 ${summary.new} 个新工作区` : '没有新工作区';
  return summary.enable_auto_run > 0
    ? `${found}；导入会为 ${summary.enable_auto_run} 个已有项目开启自动执行。`
    : `${found}；已有项目不受影响。`;
}

export function useCodexImportPreview() {
  const [state, setState] = useState({ status: 'loading', preview: null });
  const refresh = useCallback(async () => {
    try {
      setState({ status: 'ready', preview: await projectsApi.previewCodexImport() });
    } catch {
      setState({ status: 'error', preview: null });
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  return [state, refresh];
}
