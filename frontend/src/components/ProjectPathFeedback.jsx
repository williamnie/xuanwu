import { useEffect, useState } from 'react';
import { projectsApi } from '../api/projects.js';
export default function ProjectPathFeedback({ path, onResult }) {
  const [state, setState] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      if (!path.trim()) { setState(null); onResult?.(null); return; }
      setState({ loading: true }); onResult?.(null);
      try {
        const result = await projectsApi.validatePath(path, { signal: controller.signal });
        if (!controller.signal.aborted) { setState(result); onResult?.(result); }
      } catch (error) { if (!controller.signal.aborted) { setState({ reason: error.message || '路径检查失败' }); onResult?.(null); } }
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [path, onResult]);
  if (!state) return null;
  return <span className="project-settings-hint" role="status">{state.loading ? '正在检查路径…' : state.reason || `路径存在 · 目录 · ${state.is_git_repository ? 'Git 仓库' : '非 Git 仓库'}`}</span>;
}
