import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { 
  Plus, 
  X, 
  Clock, 
  Sparkles,
  Link2
} from 'lucide-react';

export default function Issues({
  projects,
  issues,
  filterProject,
  focusFilter,
  isNewIssueOpen,
  setIsNewIssueOpen,
  prefilledStatus,
  handleOpenNewIssue,
  navigateTo,
  loadAllData
}) {
  // 新建 Issue 的局部表单状态
  const [formTitle, setFormTitle] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formProjectId, setFormProjectId] = useState(projects[0]?.id || '');
  const [formPriority, setFormPriority] = useState(0);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 拖拽相关的局部交互状态
  const [draggingIssueId, setDraggingIssueId] = useState(null);
  const [draggedOverColumnId, setDraggedOverColumnId] = useState(null);

  // 拖拽开始：记录被拖拽的任务 ID 与当前状态，并设置拖拽状态
  const handleDragStart = (e, issueId, currentStatus) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ issueId, currentStatus }));
    e.dataTransfer.effectAllowed = 'move';
    // 在下一个宏任务或微任务中设置正在拖动的样式，保证拖动时半透明卡片阴影生成不受影响
    setTimeout(() => {
      setDraggingIssueId(issueId);
    }, 0);
  };

  // 拖拽结束：清理卡片拖拽状态
  const handleDragEnd = () => {
    setDraggingIssueId(null);
    setDraggedOverColumnId(null);
  };

  // 拖拽悬停列上：允许 drop，并记录被悬停的列 ID
  const handleDragOver = (e, columnId) => {
    e.preventDefault();
    if (draggedOverColumnId !== columnId) {
      setDraggedOverColumnId(columnId);
    }
  };

  // 拖拽离开列：清除被悬停列 ID
  const handleDragLeave = (e, columnId) => {
    if (draggedOverColumnId === columnId) {
      setDraggedOverColumnId(null);
    }
  };

  // 拖拽释放：处理状态更改 API 调用
  const handleDrop = async (e, targetStatus) => {
    e.preventDefault();
    setDraggedOverColumnId(null);
    setDraggingIssueId(null);

    const dataStr = e.dataTransfer.getData('text/plain');
    if (!dataStr) return;

    try {
      const { issueId, currentStatus } = JSON.parse(dataStr);
      
      // 如果目标状态和当前状态一致，或者目标状态是在 cancelled 列且当前状态已是 cancelled/failed，则忽略
      const isTargetCancelled = targetStatus === 'cancelled';
      const isCurrentCancelled = currentStatus === 'cancelled' || currentStatus === 'failed';
      
      if (currentStatus === targetStatus || (isTargetCancelled && isCurrentCancelled)) {
        return;
      }

      // 调用接口更新状态
      await api.updateIssue(issueId, { status: targetStatus });
      
      // 成功后重新加载数据，保证即时同步
      loadAllData();
    } catch (err) {
      console.error('更新 Issue 状态失败:', err);
      alert(`更改状态失败: ${err.message || '网络异常'}`);
    }
  };

  // 当模态框打开时重置表单输入内容，防止轮询更新项目列表时清空用户输入
  useEffect(() => {
    if (isNewIssueOpen) {
      setFormTitle('');
      setFormDescription('');
      setFormPriority(0);
      setFormError('');
    }
  }, [isNewIssueOpen]);

  // 当模态框打开或者项目列表变化时，同步关联项目 ID，但不影响已输入内容和用户手动选择
  useEffect(() => {
    if (isNewIssueOpen) {
      setFormProjectId(prev => {
        if (projects && projects.length > 0) {
          if (prev && projects.some(p => p.id === prev)) {
            return prev;
          }
          return projects[0].id;
        }
        return '';
      });
    }
  }, [isNewIssueOpen, projects]);

  // 相对时间计算函数，完美还原截图如 "19h"、"2d" 等显示
  const getRelativeTime = (dateStr) => {
    if (!dateStr) return '0m';
    const now = new Date();
    const date = new Date(dateStr);
    const diffMs = now - date;
    
    const minutes = Math.floor(diffMs / 60000);
    const hours = Math.floor(diffMs / 3600000);
    const days = Math.floor(diffMs / 86400000);

    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    if (hours < 24) return `${hours}h`;
    return `${days}d`;
  };

  const handleCreateIssue = async (e) => {
    e.preventDefault();
    if (!formTitle.trim()) {
      setFormError('任务标题不能为空');
      return;
    }
    const finalProjectId = formProjectId || (projects[0]?.id || '');
    if (!finalProjectId) {
      setFormError('请先创建项目');
      return;
    }

    setSubmitting(true);
    setFormError('');

    const payload = {
      title: formTitle,
      description: formDescription,
      project_id: finalProjectId,
      priority: parseInt(formPriority),
      status: prefilledStatus || 'triage',
    };

    try {
      await api.createIssue(payload);
      setIsNewIssueOpen(false);
      setFormTitle('');
      setFormDescription('');
      loadAllData();
    } catch (err) {
      setFormError(err.message || '新建 Issue 失败');
    } finally {
      setSubmitting(false);
    }
  };

  // 1. 过滤当前项目的 Issue 列表
  const projectIssues = issues.filter(i => !filterProject || i.project_id === filterProject);

  // 2. 将 Issue 数据按照看板状态分类
  const triageIssues = projectIssues.filter(i => i.status === 'triage');
  const todoIssues = projectIssues.filter(i => i.status === 'todo');
  const inProgressIssues = projectIssues.filter(i => i.status === 'in_progress');
  const doneIssues = projectIssues.filter(i => i.status === 'done');
  
  // 截图中的 Cancelled 列合并了 cancelled 和 failed 的任务，提供清晰的报错展示
  const cancelledIssues = projectIssues.filter(i => i.status === 'cancelled' || i.status === 'failed');

  // 3. 看板五列的配置信息
  const columns = [
    {
      id: 'triage',
      title: 'Triage',
      dotColor: '#fbbf24', // 黄色
      emptyText: 'no agent-filed issues waiting',
      issues: triageIssues
    },
    {
      id: 'todo',
      title: 'Todo',
      dotColor: '#64748b', // 灰色
      emptyText: 'nothing queued',
      issues: todoIssues
    },
    {
      id: 'in_progress',
      title: 'In Progress',
      dotColor: '#3b82f6', // 蓝色
      emptyText: 'nothing in flight',
      issues: inProgressIssues
    },
    {
      id: 'done',
      title: 'Done',
      dotColor: '#10b981', // 绿色
      emptyText: 'nothing completed',
      issues: doneIssues
    },
    {
      id: 'cancelled',
      title: 'Cancelled',
      dotColor: '#ef4444', // 红色
      emptyText: 'nothing cancelled',
      issues: cancelledIssues
    }
  ];

  // 4. 根据侧边栏 FOCUS 过滤器决定渲染哪些列
  const getVisibleColumns = () => {
    switch (focusFilter) {
      case 'triage':
        return columns.filter(c => c.id === 'triage');
      case 'active':
        return columns.filter(c => c.id === 'todo' || c.id === 'in_progress');
      case 'archive':
        return columns.filter(c => c.id === 'done' || c.id === 'cancelled');
      case 'all':
      default:
        return columns;
    }
  };

  const visibleColumns = getVisibleColumns();

  return (
    <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', height: '100%', flex: 1 }}>
      
      {/* 头部控制栏 (对齐截图) */}
      <div className="view-header">
        <h1 className="view-title">
          Issues <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem', fontWeight: 500 }}>— {projectIssues.length}</span>
        </h1>
        
        {/* 新增 Issue 动作按钮 */}
        <button 
          className="btn btn-primary" 
          style={{ padding: '6px 12px', fontSize: '0.78rem' }}
          onClick={() => handleOpenNewIssue('todo')}
        >
          <Plus size={14} /> New issue
        </button>
      </div>

      {/* 核心看板网格组件 */}
      <div className="kanban-board">
        {visibleColumns.map(col => (
          <div 
            key={col.id} 
            className={`kanban-column ${draggedOverColumnId === col.id ? 'drag-over' : ''}`}
            onDragOver={(e) => handleDragOver(e, col.id)}
            onDragLeave={(e) => handleDragLeave(e, col.id)}
            onDrop={(e) => handleDrop(e, col.id)}
          >
            
            {/* 列头部 */}
            <div className="kanban-column-header">
              <div className="kanban-column-title">
                <span className="kanban-column-dot" style={{ background: col.dotColor }}></span>
                <span>{col.title}</span>
                <span className="kanban-column-count">{col.issues.length}</span>
              </div>
              <button 
                className="kanban-column-add-btn" 
                onClick={() => handleOpenNewIssue(col.id === 'cancelled' ? 'cancelled' : col.id)}
                title={`添加新任务到 ${col.title}`}
              >
                <Plus size={14} />
              </button>
            </div>

            {/* 卡片容器 */}
            <div className="kanban-cards-container">
              {col.issues.length === 0 ? (
                <div className="kanban-column-empty">
                  {col.emptyText}
                </div>
              ) : (
                col.issues.map(issue => {
                  const proj = projects.find(p => p.id === issue.project_id);
                  return (
                    <div 
                      key={issue.id} 
                      className={`kanban-card ${draggingIssueId === issue.id ? 'dragging' : ''}`}
                      draggable="true"
                      onDragStart={(e) => handleDragStart(e, issue.id, issue.status)}
                      onDragEnd={handleDragEnd}
                      onClick={() => navigateTo('issues', issue.id)}
                    >
                      {/* ID 和 标题 */}
                      <div className="kanban-card-title">
                        #{issue.id} {issue.title}
                      </div>

                      {/* 底部属性与微标 */}
                      <div className="kanban-card-footer">
                        
                        {/* 关联项目微标 (带圆点指示) */}
                        <span className="kanban-card-project">
                          <span 
                            style={{ 
                              width: '6px', 
                              height: '6px', 
                              borderRadius: '50%', 
                              background: '#f97316', // 截图中的橙色圆点
                              display: 'inline-block'
                            }}
                          ></span>
                          {proj ? proj.name : issue.project_id}
                        </span>

                        {/* 更新时间时效 与 循环回合数 */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                            <Clock size={11} style={{ opacity: 0.6 }} />
                            {getRelativeTime(issue.updated_at)}
                          </span>
                          <span className="kanban-card-loops" title="Codex 执行回合数">
                            <Link2 size={11} style={{ transform: 'rotate(-45deg)', opacity: 0.6 }} />
                            {issue.attempt_count || 1}
                          </span>
                        </div>

                      </div>
                    </div>
                  );
                })
              )}
            </div>

          </div>
        ))}
      </div>

      {/* 新建 Issue 高级模态框 (完美融合) */}
      {isNewIssueOpen && (
        <div className="modal-overlay">
          <div className="glass-card modal-content" style={{ maxWidth: '460px', padding: '24px' }}>
            
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 style={{ fontSize: '1.05rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Sparkles size={16} color="var(--primary)" /> 创建新 Issue ({prefilledStatus.toUpperCase()})
              </h3>
              <button 
                style={{ background: 'transparent', color: 'var(--text-muted)', border: 'none', cursor: 'pointer' }}
                onClick={() => setIsNewIssueOpen(false)}
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleCreateIssue} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              
              {formError && (
                <div style={{ color: 'var(--error)', background: 'var(--error-bg)', padding: '8px 12px', borderRadius: '4px', fontSize: '0.78rem' }}>
                  {formError}
                </div>
              )}

              {projects.length === 0 ? (
                <div style={{ color: 'var(--warning)', background: 'var(--warning-bg)', padding: '10px 14px', borderRadius: '6px', fontSize: '0.8rem', display: 'flex', flexDirection: 'column', gap: '4px', border: '1px solid rgba(245, 158, 11, 0.15)' }}>
                  <strong style={{ fontWeight: 600 }}>暂无项目可关联</strong>
                  <span>请先前往「Projects」项目管理页面新增监控项目，然后再在此创建任务。</span>
                </div>
              ) : (
                <div className="form-group">
                  <label>关联目标项目 *</label>
                  <select 
                    className="form-control" 
                    value={formProjectId}
                    onChange={(e) => setFormProjectId(e.target.value)}
                    required
                  >
                    {projects.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="form-group">
                <label>任务标题 / 描述性诉求 *</label>
                <input 
                  type="text" 
                  className="form-control" 
                  placeholder="例如: 修复节点删除后的状态流转 bug"
                  value={formTitle}
                  onChange={(e) => setFormTitle(e.target.value)}
                  required 
                />
              </div>

              <div className="form-group">
                <label>故障详情 / 附加修复上下文</label>
                <textarea 
                  className="form-control" 
                  rows={4}
                  placeholder="可在此写入复现路径、报错日志等。Codex 代理将作为上下文参考..."
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  style={{ resize: 'vertical' }}
                />
              </div>

              <div className="form-group">
                <label>任务优先级</label>
                <select 
                  className="form-control" 
                  value={formPriority}
                  onChange={(e) => setFormPriority(e.target.value)}
                >
                  <option value={0}>普通优先级</option>
                  <option value={1}>中优先级</option>
                  <option value={2}>紧急插队 (High)</option>
                </select>
              </div>

              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '10px' }}>
                <button type="button" className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={() => setIsNewIssueOpen(false)}>
                  取消
                </button>
                <button type="submit" className="btn btn-primary" style={{ padding: '6px 16px' }} disabled={submitting || projects.length === 0}>
                  {submitting ? '创建中...' : '提交创建'}
                </button>
              </div>

            </form>

          </div>
        </div>
      )}

    </div>
  );
}
