import { useState, useEffect } from 'react';
import { api } from './api/client';
import Dashboard from './pages/Dashboard';
import Projects from './pages/Projects';
import Issues from './pages/Issues';
import IssueDetail from './pages/IssueDetail';
import Sessions from './pages/Sessions';
import { 
  MessageSquare, 
  Layers, 
  ListTodo, 
  Settings, 
  FolderGit2, 
  Sun, 
  Moon,
  Loader2
} from 'lucide-react';

export default function App() {
  // 共享的核心数据状态
  const [projects, setProjects] = useState([]);
  const [issues, setIssues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [backendOnline, setBackendOnline] = useState(false);

  // 路由与过滤状态
  const [currentPage, setCurrentPage] = useState('issues'); // 默认进入 Issues 看板以响应用户偏好
  const [selectedIssueId, setSelectedIssueId] = useState(null);
  
  // 侧边栏过滤器
  const [filterProject, setFilterProject] = useState(''); // '' 表示 Any project
  const [focusFilter, setFocusFilter] = useState('all'); // 'all' | 'triage' | 'active' | 'archive'

  // 新增 Issue 弹窗的全局状态（可以从侧边栏 + 看板列头触发）
  const [isNewIssueOpen, setIsNewIssueOpen] = useState(false);
  const [prefilledStatus, setPrefilledStatus] = useState('triage');

  // 主题状态 (默认亮色以匹配截图，支持一键切换)
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('codex-theme') || 'light';
  });

  const loadAllData = async () => {
    try {
      const [projList, issueList] = await Promise.all([
        api.getProjects(),
        api.getIssues()
      ]);
      setProjects(projList || []);
      setIssues(issueList || []);
      setBackendOnline(true);
    } catch {
      setBackendOnline(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAllData();
    // 启动 3 秒周期轮询，保证看板与侧边栏计数实时同步
    const interval = setInterval(loadAllData, 3000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('codex-theme', theme);
  }, [theme]);

  // 订阅 SSE 实时变更，触发数据刷新
  useEffect(() => {
    const unsubscribe = api.subscribeToEvents((event) => {
      if (
        event.type === 'issue.created' || 
        event.type === 'issue.status_changed' ||
        event.type === 'issue.error' ||
        event.type === 'runner.started' ||
        event.type === 'runner.stopped'
      ) {
        loadAllData();
      }
    });
    return () => unsubscribe();
  }, []);

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  const navigateTo = (page, issueId = null) => {
    setCurrentPage(page);
    setSelectedIssueId(issueId);
  };

  // --- 侧边栏统计逻辑 (精确匹配截图) ---
  const getIssuesForProject = (projId) => {
    return issues.filter(i => !projId || i.project_id === projId);
  };

  const filteredIssuesList = getIssuesForProject(filterProject);

  // Focus 各项的计数
  const triageCount = filteredIssuesList.filter(i => i.status === 'triage').length;
  const activeCount = filteredIssuesList.filter(i => i.status === 'todo' || i.status === 'in_progress').length;
  const archiveCount = filteredIssuesList.filter(i => i.status === 'done' || i.status === 'failed' || i.status === 'cancelled').length;
  const allCount = filteredIssuesList.length;

  // Loop Auto 运行中项目数计算
  const activeLoops = projects.filter(p => p.loop_status === 'running' || p.auto_run === 1).length;
  const totalProjects = projects.length;

  const handleOpenNewIssue = (status = 'triage') => {
    setPrefilledStatus(status);
    setIsNewIssueOpen(true);
  };

  return (
    <div className="app-container">
      {/* 左侧侧边栏 */}
      <aside className="sidebar">
        
        {/* 1. 用户头像与运行状态 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '4px 8px', marginBottom: '24px' }}>
          <div style={{ 
            width: '32px', 
            height: '32px', 
            borderRadius: '50%', 
            background: 'linear-gradient(135deg, #10b981 0%, #3b82f6 100%)',
            color: 'white',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '0.85rem',
            fontWeight: 700
          }}>
            XB
          </div>
          <div className="logo-text">
            <h2 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.2 }}>
              xiaobei
            </h2>
            <span style={{ fontSize: '0.62rem', color: backendOnline ? '#10b981' : '#ef4444', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: backendOnline ? '#10b981' : '#ef4444' }}></span>
              {backendOnline ? 'LOCAL API • ONLINE' : 'LOCAL API • OFFLINE'}
            </span>
          </div>
        </div>

        {/* 2. 主导航菜单 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          
          <button className="nav-item">
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <MessageSquare size={16} /> Chat
            </span>
            <span className="nav-badge">—</span>
          </button>

          <button 
            className={`nav-item ${currentPage === 'sessions' ? 'active' : ''}`}
            onClick={() => navigateTo('sessions')}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Layers size={16} /> Sessions
            </span>
            <span className="nav-badge">∞</span>
          </button>

          <button 
            className={`nav-item ${currentPage === 'issues' ? 'active' : ''}`}
            onClick={() => navigateTo('issues')}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ListTodo size={16} /> Issues
            </span>
            <span className="nav-badge" style={{ background: currentPage === 'issues' ? 'var(--primary-glow)' : undefined, color: currentPage === 'issues' ? 'var(--primary)' : undefined }}>{issues.length}</span>
          </button>

          <button 
            className={`nav-item ${currentPage === 'projects' ? 'active' : ''}`}
            onClick={() => navigateTo('projects')}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <FolderGit2 size={16} /> Projects
            </span>
            <span className="nav-badge" style={{ background: currentPage === 'projects' ? 'var(--primary-glow)' : undefined, color: currentPage === 'projects' ? 'var(--primary)' : undefined }}>{projects.length}</span>
          </button>

        </div>

        {/* 3. Issues 专属过滤器子菜单 (仅在进入 Issues/Dashboard 页时充分展现) */}
        {currentPage === 'issues' && (
          <>
            <div className="sidebar-section-title">
              <span>— Issues • {issues.length}</span>
            </div>

            {/* + New issue 按钮 */}
            <button className="btn-new-issue-sidebar" onClick={() => handleOpenNewIssue('todo')}>
              <span>+ New issue</span>
              <span style={{ fontSize: '0.65rem', border: '1px solid rgba(16,185,129,0.3)', padding: '1px 4px', borderRadius: '3px', background: 'rgba(16,185,129,0.06)' }}>c</span>
            </button>

            {/* Loop Auto 指示器 */}
            <div style={{ padding: '12px 12px 4px 12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                <span>LOOP AUTO</span>
                <span>{activeLoops} / {totalProjects}</span>
              </div>
              <div className="sidebar-progress">
                <div className="sidebar-progress-fill" style={{ width: `${totalProjects > 0 ? (activeLoops / totalProjects) * 100 : 0}%` }}></div>
              </div>
            </div>

            {/* FOCUS 子项 */}
            <div className="sidebar-section-title">Focus</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
              <button 
                className={`sub-filter-item ${focusFilter === 'all' ? 'active' : ''}`}
                onClick={() => setFocusFilter('all')}
              >
                <span>All columns</span>
                <span>{allCount}</span>
              </button>

              <button 
                className={`sub-filter-item ${focusFilter === 'triage' ? 'active' : ''}`}
                onClick={() => setFocusFilter('triage')}
              >
                <span>
                  <span className="sub-filter-dot" style={{ background: '#f59e0b' }}></span>
                  Just Triage
                </span>
                <span>{triageCount}</span>
              </button>

              <button 
                className={`sub-filter-item ${focusFilter === 'active' ? 'active' : ''}`}
                onClick={() => setFocusFilter('active')}
              >
                <span>
                  <span className="sub-filter-dot" style={{ background: '#3b82f6' }}></span>
                  Active only
                </span>
                <span>{activeCount}</span>
              </button>

              <button 
                className={`sub-filter-item ${focusFilter === 'archive' ? 'active' : ''}`}
                onClick={() => setFocusFilter('archive')}
              >
                <span>
                  <span className="sub-filter-dot" style={{ background: '#10b981' }}></span>
                  Archive
                </span>
                <span>{archiveCount}</span>
              </button>
            </div>

            {/* PROJECT 子项 */}
            <div className="sidebar-section-title">Project</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
              <button 
                className={`sub-filter-item ${filterProject === '' ? 'active' : ''}`}
                onClick={() => setFilterProject('')}
              >
                <span>All projects</span>
                <span>{issues.length}</span>
              </button>

              {projects.map(proj => {
                const count = issues.filter(i => i.project_id === proj.id).length;
                return (
                  <button 
                    key={proj.id}
                    className={`sub-filter-item ${filterProject === proj.id ? 'active' : ''}`}
                    onClick={() => setFilterProject(proj.id)}
                  >
                    <span>
                      <span className="sub-filter-dot" style={{ background: 'var(--primary)' }}></span>
                      {proj.name}
                    </span>
                    <span>{count}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {/* 底部系统配置与明暗切换 */}
        <div style={{ marginTop: 'auto', borderTop: '1px solid var(--border-color)', paddingTop: '16px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          
          <button className="nav-item" style={{ paddingLeft: '8px' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Settings size={16} /> Settings
            </span>
            <span className="nav-badge">—</span>
          </button>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 8px', marginTop: '6px' }}>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600 }}>明暗主题</span>
            <button 
              className="btn btn-secondary" 
              style={{ padding: '6px', borderRadius: '6px', border: '1px solid var(--border-color)' }}
              onClick={toggleTheme}
            >
              {theme === 'dark' ? <Sun size={14} color="#fbbf24" /> : <Moon size={14} color="var(--primary)" />}
            </button>
          </div>
          
          <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', textAlign: 'center', marginTop: '4px' }}>
            © 2026 Codex Loop Runner
          </div>
        </div>

      </aside>

      {/* 右侧主工作区 */}
      <main className="main-content">
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: '16px' }}>
            <Loader2 className="animate-spin" size={32} color="var(--primary)" />
            <p style={{ color: 'var(--text-secondary)' }}>载入系统中...</p>
          </div>
        ) : (
          currentPage === 'issues' && selectedIssueId ? (
            <IssueDetail issueId={selectedIssueId} navigateTo={navigateTo} />
          ) : currentPage === 'issues' ? (
            <Issues 
              projects={projects}
              issues={issues}
              filterProject={filterProject}
              focusFilter={focusFilter}
              isNewIssueOpen={isNewIssueOpen}
              setIsNewIssueOpen={setIsNewIssueOpen}
              prefilledStatus={prefilledStatus}
              handleOpenNewIssue={handleOpenNewIssue}
              navigateTo={navigateTo}
              loadAllData={loadAllData}
            />
          ) : currentPage === 'projects' ? (
            <Projects navigateTo={navigateTo} />
          ) : currentPage === 'sessions' ? (
            <Sessions projects={projects} />
          ) : (
            <Dashboard navigateTo={navigateTo} />
          )
        )}
      </main>
    </div>
  );
}
