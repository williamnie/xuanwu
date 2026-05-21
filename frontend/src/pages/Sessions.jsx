import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Loader2, Play, Plus, RefreshCw, Square, Terminal } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api/client';
import VirtualSessionList from './sessions/VirtualSessionList';
import './sessions/Sessions.css';

const PAGE_SIZE = 50;
const markdownPlugins = [remarkGfm];

function displayTitle(session) {
  return session?.name || session?.preview || 'Untitled Codex session';
}

function flattenItems(turns) {
  if (!Array.isArray(turns)) return [];
  return turns.flatMap((turn) => (turn.items || []).map((item) => ({ ...item, turnId: turn.id })));
}

function textFromUserContent(content) {
  if (!Array.isArray(content)) return '';
  return content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
}

function renderItemText(item) {
  if (item.type === 'userMessage') return textFromUserContent(item.content);
  if (item.type === 'agentMessage') return item.text || '';
  if (item.type === 'commandExecution') return item.command || item.text || '';
  return item.text || item.type;
}

function eventLine(event) {
  if (event.text) return event.text;
  if (event.error) return event.error;
  if (event.status) return `${event.method}: ${event.status}`;
  return event.method || 'codex.event';
}

export default function Sessions({ projects = [] }) {
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

  const selectedItems = useMemo(() => flattenItems(selectedSession?.turns), [selectedSession]);
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
          {selectedSession ? <SessionDetail session={selectedSession} items={selectedItems} liveEvents={liveEvents} /> : <EmptyDetail />}
          <form className="session-composer" onSubmit={sendMessage}>
            <textarea className="form-control" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="给当前 Codex session 发送消息..." />
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

function SessionDetail({ session, items, liveEvents }) {
  return (
    <div className="session-detail-body">
      <div className="session-detail-head">
        <h1>{displayTitle(session)}</h1>
        <code>{session.id}</code>
        <span>{session.cwd}</span>
      </div>
      <div className="session-transcript">
        {items.map((item) => <MessageItem key={`${item.turnId}-${item.id}`} item={item} />)}
        {liveEvents.map((event, index) => <LiveEvent key={`${event.turnId}-${index}`} event={event} />)}
      </div>
    </div>
  );
}

function MessageItem({ item }) {
  const role = item.type === 'userMessage' ? 'user' : 'agent';
  return <div className={`session-message ${role}`}><strong>{role}</strong><MarkdownText text={renderItemText(item)} /></div>;
}

function LiveEvent({ event }) {
  return <div className="session-message live"><strong>{event.method}</strong><MarkdownText text={eventLine(event)} /></div>;
}

function MarkdownText({ text }) {
  return (
    <div className="session-markdown">
      <ReactMarkdown remarkPlugins={markdownPlugins}>{text || ''}</ReactMarkdown>
    </div>
  );
}

function CreateSessionModal({ projects, projectId, cwd, prompt, sending, selectedProject, onProjectChange, onCwdChange, onPromptChange, onClose, onSubmit }) {
  return (
    <div className="modal-overlay">
      <form className="modal-content" onSubmit={onSubmit}>
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
          <textarea className="form-control" rows={5} value={prompt} onChange={(e) => onPromptChange(e.target.value)} placeholder="创建后立即发送给 Codex..." />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>取消</button>
          <button className="btn btn-primary" disabled={sending}>{sending ? <Loader2 className="animate-spin" size={15} /> : <Plus size={15} />} 创建</button>
        </div>
      </form>
    </div>
  );
}
