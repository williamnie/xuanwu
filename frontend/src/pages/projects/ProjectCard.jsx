import { appHashForRoute } from '../../appRouteModel.js';
import { useI18n } from '../../i18n/context.js';
import RemoteProjectBadge from '../../components/RemoteProjectBadge.jsx';
import { ArrowUpRight, Folder, Settings, Trash2 } from 'lucide-react';
import ProjectHoldNotice from '../ProjectHoldNotice';

function compactPath(cwd = '') {
  const text = String(cwd || '').trim().replace(/[\\/]+$/, '');
  const parts = text.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 3) return text || '—';
  return `…/${parts.slice(-2).join('/')}`;
}

/** 远程项目显示「节点名:路径」，本机项目只显示路径。 */
function projectLocationText(project, nodesById) {
  if (!project.node_id) return compactPath(project.cwd);
  const node = nodesById.get(project.node_id);
  return `${node?.name || project.node_id}:${compactPath(project.node_path)}`;
}

export default function ProjectCard({ proj, counts, nodesById, handleResumeHold, resumingHoldProjectId, handleOpenEditModal, handleOpenDeleteModal }) {
  const { t } = useI18n();
              const activeCount = counts.in_progress || 0;

              const isHeld = Boolean(proj.hold);
              const isLoopActive = !isHeld && (proj.loop_status === 'running' || proj.auto_run === 1);
              const nodeOffline = Boolean(proj.node_id) && nodesById.get(proj.node_id)?.online === false;

              return (
                <div key={proj.id} className="glass-card project-card">

                  {/* 项目基本信息 */}
                  <div className="project-card-header">
                    <div className="project-card-identity">
                      <div className="project-card-icon">
                        <Folder size={16} />
                      </div>
                      <div className="project-card-title">
                        <div className="project-card-name">
                          <h3 title={proj.name}>
                            {proj.name}
                          </h3>
                          <RemoteProjectBadge project={proj} nodesById={nodesById} />
                        </div>
                        <code title={proj.node_id ? `${proj.node_id}:${proj.node_path}` : proj.cwd}>
                          {projectLocationText(proj, nodesById)}
                        </code>
                      </div>
                    </div>

                    <div className="project-status-pill">
                      <span className={`status-dot ${nodeOffline ? 'idle' : activeCount > 0 ? 'running' : isLoopActive ? 'active' : 'idle'}`}></span>
                      <span>
                        {isHeld ? 'Hold' : nodeOffline ? '节点离线' : activeCount > 0 ? '运行中' : isLoopActive ? '监听中' : '已暂停'}
                      </span>
                    </div>
                  </div>

                  <ProjectHoldNotice
                    hold={proj.hold}
                    onResume={() => handleResumeHold(proj.id)}
                    resuming={resumingHoldProjectId === proj.id}
                  />

                  {/* 项目配置操作 */}
                  <div className="project-card-footer">
                    <a
                      className="project-card-tasks-link"
                      href={appHashForRoute({ currentPage: 'tasks', filterProject: proj.id, taskScope: 'all' })}
                    >
                      {t('projects.viewTasks')} <ArrowUpRight size={13} />
                    </a>
                    <div className="project-card-actions">
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
                        onClick={() => handleOpenDeleteModal(proj)}
                        aria-label={`删除 ${proj.name}`}
                        title="删除"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>

                  </div>

                </div>
              );
}
