import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronRight, FileCode, Loader2, Play, Plus, RefreshCw, Settings, Square, Terminal } from 'lucide-react';
import { api } from '../api/client';
import MarkdownPreview from '../components/editor/MarkdownPreview';
import PromptEditor from '../components/editor/PromptEditor';
import { localImagePathToAttachmentMarkdown } from '../components/editor/attachments';
import { selectProjects, useDataStore } from '../store/dataStore';
import VirtualSessionList from './sessions/VirtualSessionList';
import './sessions/Sessions.css';

const PAGE_SIZE = 50;

function textFromUserContent(content) {
  if (!Array.isArray(content)) return '';
  return content.map((item) => {
    if (item.type === 'text' || item.type === 'input_text') return item.text || '';
    if (item.type === 'localImage') return localImagePathToAttachmentMarkdown(item.path);
    if (item.type === 'image' || item.type === 'input_image') return `![image](${item.url || item.image_url || ''})`;
    return '';
  }).filter(Boolean).join('\n\n');
}

export default function Sessions() {
  const projects = useDataStore(selectProjects);
  const [sessions, setSessions] = useState([]);
  const [cursor, setCursor] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [selectedSession, setSelectedSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [liveEvents, setLiveEvents] = useState([]);

  const selectedProject = projects.find((project) => project.id === projectId);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.getSessions({ limit: PAGE_SIZE });
      const data = result.data || [];
      setSessions(data);
      setCursor(result.nextCursor || '');
      setSelectedId((current) => current || data[0]?.id || '');
      setError('');
    } catch (err) {
      setError(err.message || '加载 Codex sessions 失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await api.getSessions({ limit: PAGE_SIZE, cursor });
      setSessions((prev) => mergeSessions(prev, result.data || []));
      setCursor(result.nextCursor || '');
    } catch (err) {
      setError(err.message || '继续加载 sessions 失败');
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore]);

  const loadSelected = useCallback(async () => {
    if (!selectedId) return;
    try {
      const detail = await api.getSession(selectedId);
      setSelectedSession(detail);
      setError('');
    } catch (err) {
      setError(err.message || '读取 session 详情失败');
    }
  }, [selectedId]);

  useEffect(() => { loadFirstPage(); }, [loadFirstPage]);
  useEffect(() => { loadSelected(); }, [loadSelected]);

  useEffect(() => api.subscribeToEvents((event) => {
    if (event.type !== 'codex.event' || event.threadId !== selectedId) return;
    setLiveEvents((prev) => [...prev, event].slice(-200));
    if (event.method === 'turn/completed') {
      loadSelected();
      loadFirstPage();
    }
  }), [loadFirstPage, loadSelected, selectedId]);

  const openCreate = () => {
    setProjectId(projects[0]?.id || '');
    setCwd(projects[0]?.cwd || '');
    setPrompt('');
    setIsCreateOpen(true);
  };

  const createSession = async (event) => {
    event.preventDefault();
    setSending(true);
    try {
      const result = await api.createSession({ project_id: projectId, cwd, prompt });
      setIsCreateOpen(false);
      setSelectedId(result.thread_id);
      setLiveEvents([]);
      await loadFirstPage();
    } catch (err) {
      setError(err.message || '创建 session 失败');
    } finally {
      setSending(false);
    }
  };

  const sendMessage = async (event) => {
    event.preventDefault();
    if (!selectedId || !message.trim()) return;
    setSending(true);
    try {
      await api.sendSessionMessage(selectedId, message);
      setMessage('');
      setLiveEvents([]);
    } catch (err) {
      setError(err.message || '发送消息失败');
    } finally {
      setSending(false);
    }
  };

  const interrupt = async () => {
    if (!selectedId) return;
    await api.interruptSession(selectedId);
  };

  if (loading && sessions.length === 0) {
    return <LoadingState />;
  }

  return (
    <div className="sessions-page animate-fade-in">
      <header className="view-header">
        <div className="view-title"><Terminal size={18} /> Codex Sessions</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={loadFirstPage}><RefreshCw size={16} /> 刷新</button>
          <button className="btn btn-primary" onClick={openCreate}><Plus size={16} /> New session</button>
        </div>
      </header>

      {error && <ErrorBanner message={error} />}

      <div className="sessions-shell">
        <section className="sessions-sidebar glass-card">
          <VirtualSessionList
            sessions={sessions}
            projects={projects}
            selectedId={selectedId}
            hasMore={Boolean(cursor)}
            loadingMore={loadingMore}
            onSelect={(id) => { setSelectedId(id); setLiveEvents([]); }}
            onLoadMore={loadMore}
          />
        </section>

        <section className="session-detail glass-card">
          {selectedSession ? <SessionDetail session={selectedSession} liveEvents={liveEvents} /> : <EmptyDetail />}
          <form className="session-composer" onSubmit={sendMessage}>
            <PromptEditor
              value={message}
              onChange={setMessage}
              placeholder="给当前 Codex session 发送消息..."
              minHeight={110}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary" onClick={interrupt}><Square size={15} /> Stop</button>
              <button className="btn btn-primary" disabled={sending || !selectedId}><Play size={15} /> 发送</button>
            </div>
          </form>
        </section>
      </div>

      {isCreateOpen && (
        <CreateSessionModal
          projects={projects}
          projectId={projectId}
          cwd={cwd}
          prompt={prompt}
          sending={sending}
          selectedProject={selectedProject}
          onProjectChange={(id) => { setProjectId(id); setCwd(projects.find((p) => p.id === id)?.cwd || cwd); }}
          onCwdChange={setCwd}
          onPromptChange={setPrompt}
          onClose={() => setIsCreateOpen(false)}
          onSubmit={createSession}
        />
      )}
    </div>
  );
}

function mergeSessions(prev, next) {
  const seen = new Set(prev.map((item) => item.id));
  return [...prev, ...next.filter((item) => !seen.has(item.id))];
}

function LoadingState() {
  return <div style={{ display: 'grid', placeItems: 'center', height: '60vh' }}><Loader2 className="animate-spin" size={36} color="var(--primary)" /></div>;
}

function ErrorBanner({ message }) {
  return <div className="glass-card session-error"><AlertCircle size={20} /> {message}</div>;
}

function EmptyDetail() {
  return <div className="session-empty">选择一个 Codex session 查看历史，或创建新 session。</div>;
}

function parseDiff(diffText) {
  if (!diffText) return [];
  const lines = diffText.split('\n');
  const files = [];
  let currentFile = null;

  for (const line of lines) {
    if (line.startsWith('--- ') || line.startsWith('diff --git ')) {
      let fullPath;
      if (line.startsWith('--- ')) {
        fullPath = line.substring(4).trim();
      } else {
        const parts = line.split(' ');
        fullPath = parts[parts.length - 1].substring(2).trim();
      }
      if (fullPath.startsWith('a/') || fullPath.startsWith('b/')) {
        fullPath = fullPath.substring(2);
      }
      const name = fullPath.split('/').pop() || fullPath;
      currentFile = {
        path: fullPath,
        name: name,
        added: 0,
        removed: 0,
        lines: [],
      };
      files.push(currentFile);
    } else if (currentFile) {
      currentFile.lines.push(line);
      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentFile.added++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        currentFile.removed++;
      }
    }
  }
  return files;
}

function projectNameFromPath(cwd) {
  const trimmed = String(cwd || '').trim().replace(/[\\/]+$/, '');
  if (!trimmed) return 'No project';
  return trimmed.split(/[\\/]/).pop() || 'No project';
}

function SessionDetail({ session, liveEvents }) {
  const turns = session?.turns || [];

  return (
    <div className="session-detail-body">
      <div className="session-transcript">
        {turns.map((turn, index) => (
          <TurnItem key={turn.id || index} turn={turn} />
        ))}
        {liveEvents && liveEvents.length > 0 && (
          <LiveTurnItem liveEvents={liveEvents} />
        )}
      </div>
    </div>
  );
}

function TurnItem({ turn }) {
  const elements = [];
  let currentTools = [];

  for (const item of (turn.items || [])) {
    if (item.type === 'userMessage' || item.type === 'agentMessage') {
      if (currentTools.length > 0) {
        elements.push(<ToolsCollapsible key={`${currentTools[0].id || 'tools'}-collapsible`} tools={currentTools} />);
        currentTools = [];
      }
      if (item.type === 'userMessage') {
        elements.push(<UserMessageBubble key={item.id} item={item} />);
      } else {
        elements.push(<AgentMessageBubble key={item.id} item={item} />);
      }
    } else {
      currentTools.push(item);
    }
  }

  if (currentTools.length > 0) {
    elements.push(<ToolsCollapsible key={`${currentTools[0].id || 'tools'}-collapsible`} tools={currentTools} />);
  }

  return (
    <div className="turn-container animate-fade-in">
      {elements}
    </div>
  );
}

function ToolsCollapsible({ tools, isLive }) {
  const [isOpen, setIsOpen] = useState(false);

  const commandCount = tools.filter(t => t.type === 'commandExecution').length;
  const fileCount = tools.filter(t => t.type === 'fileChange').length;
  
  let summary = '执行了辅助工具';
  if (commandCount > 0 && fileCount > 0) {
    summary = `运行了 ${commandCount} 个终端命令，修改了 ${fileCount} 个文件`;
  } else if (commandCount > 0) {
    summary = `运行了 ${commandCount} 个终端命令`;
  } else if (fileCount > 0) {
    summary = `修改了 ${fileCount} 个文件`;
  }

  if (isLive) {
    summary = '正在执行工具以解决问题...';
  }

  return (
    <div className="tools-collapsible-wrapper">
      <button 
        className={`tools-trigger-btn ${isOpen ? 'open' : ''} ${isLive ? 'live' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <span className="tools-trigger-left">
          <span className="tools-indicator-icon">
            <Settings size={13} className={isLive ? 'spin-animation' : ''} />
          </span>
          <span className="tools-trigger-text">{summary}</span>
        </span>
        <span className="tools-trigger-chevron">
          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>

      {isOpen && (
        <div className="tools-details-content animate-slide-down">
          {tools.map((tool, idx) => (
            <ToolDetailItem key={idx} tool={tool} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolDetailItem({ tool }) {
  if (tool.type === 'commandExecution') {
    return (
      <div className="tool-detail-item command">
        <div className="terminal-window">
          <div className="terminal-header">
            <div className="terminal-dots">
              <span className="dot red"></span>
              <span className="dot yellow"></span>
              <span className="dot green"></span>
            </div>
            <span className="terminal-title">zsh — {projectNameFromPath(tool.cwd || '')}</span>
          </div>
          <div className="terminal-body">
            <div className="terminal-prompt-line">
              <span className="terminal-prompt">macbook %</span>{' '}
              <span className="terminal-command-text">{tool.command || tool.text}</span>
            </div>
            {tool.text && tool.text !== tool.command && (
              <pre className="terminal-output">{tool.text}</pre>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (tool.type === 'fileChange') {
    let files;
    if (Array.isArray(tool.changes) && tool.changes.length > 0) {
      files = tool.changes.map((c) => {
        const fullPath = c.path || '';
        const name = fullPath.split('/').pop() || fullPath;
        const diffText = c.diff || '';
        const lines = diffText.split('\n');
        let added = 0;
        let removed = 0;
        for (const line of lines) {
          if (line.startsWith('+') && !line.startsWith('+++')) added++;
          else if (line.startsWith('-') && !line.startsWith('---')) removed++;
        }
        return {
          path: fullPath,
          name: name,
          added,
          removed,
          lines,
        };
      });
    } else {
      const diffText = tool.text || '';
      files = parseDiff(diffText);
    }

    if (files.length === 0) {
      const diffText = tool.text || '';
      return (
        <div className="tool-detail-item file-change">
          <div className="diff-file-card">
            <div className="diff-file-header">
              <span className="diff-file-icon"><FileCode size={14} /></span>
              <span className="diff-file-path">文件改动详情</span>
            </div>
            <div className="diff-file-body" style={{ padding: '12px 14px' }}>
              {diffText ? (
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: '0.76rem', color: 'var(--text-secondary)' }}>{diffText}</pre>
              ) : (
                <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem', fontStyle: 'italic' }}>无具体的代码差异（可能是新增空白文件、修改文件属性或未完成保存）</span>
              )}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="tool-detail-item file-change">
        {files.map((file, fIdx) => (
          <div key={fIdx} className="diff-file-card">
            <div className="diff-file-header">
              <span className="diff-file-icon"><FileCode size={14} /></span>
              <span className="diff-file-path" title={file.path}>{file.name}</span>
              <div className="diff-file-badges">
                <span className="diff-badge added">+{file.added}</span>
                <span className="diff-badge removed">-{file.removed}</span>
              </div>
            </div>
            <div className="diff-file-body">
              {file.lines.map((line, lIdx) => {
                let lineClass = 'diff-line';
                if (line.startsWith('+') && !line.startsWith('+++')) lineClass += ' added';
                else if (line.startsWith('-') && !line.startsWith('---')) lineClass += ' removed';
                else if (line.startsWith('@@')) lineClass += ' meta';
                return (
                  <div key={lIdx} className={lineClass}>
                    {line}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="tool-detail-item unknown">
      <code>{tool.type}: {tool.text}</code>
    </div>
  );
}

function UserMessageBubble({ item }) {
  const text = textFromUserContent(item.content);
  return (
    <div className="chat-bubble-container user">
      <div className="chat-bubble-avatar">U</div>
      <div className="chat-bubble-content">
        <div className="chat-bubble-sender">User</div>
        <div className="chat-bubble-body">
          <MarkdownText text={text} />
        </div>
      </div>
    </div>
  );
}

function AgentMessageBubble({ item }) {
  const text = item.text || '';
  return (
    <div className="chat-bubble-container agent animate-fade-in">
      <div className="chat-bubble-avatar agent-logo">A</div>
      <div className="chat-bubble-content">
        <div className="chat-bubble-sender">Agent</div>
        <div className="chat-bubble-body">
          <MarkdownText text={text} />
        </div>
      </div>
    </div>
  );
}

function LiveTurnItem({ liveEvents }) {
  const parsed = useMemo(() => {
    let agentMessageText = '';
    const tools = [];
    let activeTool = null;
    
    for (const event of liveEvents) {
      const method = event.method;
      const text = event.text || '';
      
      if (method === 'item/agentMessage/delta') {
        agentMessageText += text;
      } else if (method === 'item/commandExecution/outputDelta') {
        if (activeTool && activeTool.type === 'commandExecution') {
          activeTool.text += text;
        }
      } else if (method === 'item/fileChange/outputDelta' || method === 'item/fileChange/patchUpdated') {
        if (activeTool && activeTool.type === 'fileChange') {
          activeTool.text += text;
        }
      } else if (method === 'item/started') {
        let toolType = 'tool';
        let command = '';
        try {
          const payload = JSON.parse(event.payload || '{}');
          const item = payload.item || {};
          toolType = item.type || 'tool';
          command = item.command || '';
        } catch {
          if (event.payload?.includes('commandExecution')) toolType = 'commandExecution';
          if (event.payload?.includes('fileChange')) toolType = 'fileChange';
        }
        
        activeTool = {
          type: toolType,
          command: command,
          text: '',
          status: 'inProgress',
        };
        tools.push(activeTool);
      } else if (method === 'item/completed') {
        if (activeTool) {
          activeTool.status = 'completed';
        }
      }
    }
    
    return {
      tools,
      agentMessageText,
    };
  }, [liveEvents]);

  const { tools, agentMessageText } = parsed;

  return (
    <div className="turn-container active-live">
      {tools.length > 0 && <ToolsCollapsible tools={tools} isLive={true} />}
      
      {agentMessageText && (
        <div className="chat-bubble-container agent streaming">
          <div className="chat-bubble-avatar agent-logo">A</div>
          <div className="chat-bubble-content">
            <div className="chat-bubble-sender">Agent <span className="streaming-badge">Thinking...</span></div>
            <div className="chat-bubble-body">
              <MarkdownText text={agentMessageText} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MarkdownText({ text }) {
  return <MarkdownPreview text={text || ''} className="session-markdown" />;
}

function CreateSessionModal({ projects, projectId, cwd, prompt, sending, selectedProject, onProjectChange, onCwdChange, onPromptChange, onClose, onSubmit }) {
  return (
    <div className="modal-overlay">
      <form className="modal-content" style={{ maxWidth: 720 }} onSubmit={onSubmit}>
        <h3 style={{ marginBottom: 16 }}>创建 Codex Session</h3>
        <div className="form-group">
          <label>项目配置</label>
          <select className="form-control" value={projectId} onChange={(e) => onProjectChange(e.target.value)}>
            <option value="">手动输入 CWD</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>CWD</label>
          <input className="form-control" value={cwd} onChange={(e) => onCwdChange(e.target.value)} placeholder="/absolute/project/path" />
          {selectedProject && <small style={{ color: 'var(--text-muted)' }}>默认继承项目 model / sandbox / approval 设置。</small>}
        </div>
        <div className="form-group">
          <label>首条消息（可选）</label>
          <PromptEditor
            value={prompt}
            onChange={onPromptChange}
            placeholder="创建后立即发送给 Codex..."
            minHeight={160}
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={sending}>{sending ? <Loader2 className="animate-spin" size={15} /> : <Plus size={15} />} 创建</button>
        </div>
      </form>
    </div>
  );
}
