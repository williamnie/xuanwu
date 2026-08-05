import { useCallback, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, FileCode, Loader2, Settings } from 'lucide-react';
import MarkdownPreview from '../../components/editor/MarkdownPreview';
import { message as toast } from '../../store/toastStore';
import SessionCommandReplay from './SessionCommandReplay.js';
import { codexAppThreadUrl } from './codexAppLink.js';
import { buildSessionResumeCommand, markdownFilenameForSession, sessionToMarkdown } from './sessionMarkdownExport.js';
import { providerLabel } from './sessionPageRuntime';
import {
  isRenderableToolItem,
  parseLiveSessionEvents,
  shouldRenderLiveTurn,
  shouldShowLiveActivityBanner,
  toolDisplayForItem,
} from './sessionTranscriptItems';
import { useSmartAutoScroll } from './smartAutoScroll';
import { textFromUserContent } from './sourceIssue';
import { CreateSessionIssueButton, SessionInfoPopover } from './SessionInfoPanel';
import './SessionCommandReplay.css';

async function copyTextToClipboard(text) {
  if (window.navigator?.clipboard?.writeText) {
    try {
      await window.navigator.clipboard.writeText(text);
      return;
    } catch {
      // 部分自动化/非安全上下文会拒绝 Clipboard API，继续走 textarea fallback。
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!ok) throw new Error('当前浏览器不支持复制到剪贴板');
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.URL.revokeObjectURL(url);
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

function fileNameFromPath(path) {
  const value = String(path || '');
  return value.split(/[\\/]/).pop() || value;
}

function filesFromFileChangeTool(tool) {
  if (Array.isArray(tool.changes) && tool.changes.length > 0) {
    return tool.changes.map((change) => {
      const diffText = change.diff || '';
      const lines = diffText.split('\n');
      let added = 0;
      let removed = 0;
      for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) added++;
        else if (line.startsWith('-') && !line.startsWith('---')) removed++;
      }
      return {
        path: change.path || '',
        name: fileNameFromPath(change.path),
        added,
        removed,
        lines,
      };
    });
  }
  return parseDiff(tool.text || '');
}

export default function SessionTranscript({ session, project, liveEvents, optimisticUserMessages, running, sending, pendingApproval, navigateTo }) {
  const turns = useMemo(() => session?.turns || [], [session?.turns]);
  const localUserMessages = useMemo(
    () => optimisticUserMessages.filter((message) => message.sessionId === session?.id),
    [optimisticUserMessages, session?.id],
  );
  const working = Boolean(running || sending);
  const showLiveTurn = shouldRenderLiveTurn(liveEvents, working);
  const provider = providerLabel(session?.provider);
  const providerId = String(session?.provider || 'codex').toLowerCase();
  const providerSessionId = session?.provider_session_id || session?.sessionId || session?.id || '';
  const codexAppUrl = useMemo(() => codexAppThreadUrl(session), [session]);
  const resume = useMemo(() => buildSessionResumeCommand(session), [session]);
  const model = session?.model || '';
  const lastLiveEvent = liveEvents[liveEvents.length - 1];
  const autoScrollWatchKey = [
    session?.updatedAt || '',
    turns.length,
    localUserMessages.map((message) => `${message.id}:${message.prompt}`).join('|'),
    liveEvents.length,
    lastLiveEvent?.method || lastLiveEvent?.agent_event_type || '',
    lastLiveEvent?.payload || lastLiveEvent?.text || lastLiveEvent?.error || '',
    working ? 'running' : 'idle',
    pendingApproval ? 'approval' : '',
  ].join(':');
  const {
    scrollRef,
    contentRef,
    showScrollButton,
    handleScroll,
    scrollToLatest,
  } = useSmartAutoScroll({
    resetKey: session?.id || providerSessionId,
    watchKey: autoScrollWatchKey,
  });

  const copyResumeCommand = useCallback(async () => {
    if (!resume.command) {
      toast.warning(resume.note);
      return;
    }
    try {
      await copyTextToClipboard(resume.command);
      toast.success(`已复制 ${provider} resume 命令`);
    } catch (err) {
      toast.error(err.message || '复制 resume 命令失败');
    }
  }, [provider, resume]);

  const continueInRunner = useCallback(() => {
    const composer = document.querySelector('.session-composer textarea, .session-chat-workspace textarea');
    if (composer instanceof HTMLElement) composer.focus();
    toast.info(resume.note);
  }, [resume.note]);

  const downloadMarkdown = useCallback(() => {
    try {
      downloadTextFile(markdownFilenameForSession(session), sessionToMarkdown(session, { project, running }));
      toast.success('已下载 Markdown 转录');
    } catch (err) {
      toast.error(err.message || '下载 Markdown 失败');
    }
  }, [project, running, session]);

  const openCodexApp = useCallback(() => {
    if (!codexAppUrl) {
      toast.warning('当前 Session 没有可用于 Codex App 的 thread id');
      return;
    }
    window.location.href = codexAppUrl;
    toast.info('已请求在 Codex App 中打开当前 Session');
  }, [codexAppUrl]);

  return (
    <div className="session-detail-body">
      <div className="session-runtime-header">
        <div className="session-runtime-meta">
          <span>Provider: {provider}</span>
          <code title={providerSessionId}>{providerSessionId}</code>
        </div>
        <RuntimeStatusPill running={working} pendingApproval={pendingApproval} />
        <div className="session-runtime-actions">
          <div className="session-export-actions">
            {codexAppUrl ? (
              <button type="button" onClick={openCodexApp} title="在 Codex App 中打开当前 Session">
                <ExternalLink size={12} />
                在 Codex App 打开
              </button>
            ) : null}
            {resume.command ? (
              <button type="button" onClick={copyResumeCommand} title={`复制 ${provider} resume 命令`}>
                复制 resume 命令
              </button>
            ) : (
              <button type="button" onClick={continueInRunner} title={resume.note}>
                在 Runner 中继续/恢复
              </button>
            )}
            <button type="button" onClick={downloadMarkdown}>下载 Markdown</button>
          </div>
          <CreateSessionIssueButton session={session} project={project} navigateTo={navigateTo} />
          <SessionInfoPopover
            session={session}
            provider={provider}
            sessionId={providerSessionId}
            model={model}
            navigateTo={navigateTo}
          />
        </div>
      </div>
      <SessionCommandReplay history={session?.command_history || []} navigateTo={navigateTo} />
      <div className="session-transcript" ref={scrollRef} onScroll={handleScroll}>
        <div className="session-transcript-content" ref={contentRef}>
          {turns.map((turn, index) => (
            <TurnItem
              key={turn.id || index}
              turn={turn}
              turnIndex={index}
            />
          ))}
          {localUserMessages.map((message) => (
            <OptimisticUserMessageBubble key={message.id} message={message} />
          ))}
          {showLiveTurn && (
            <LiveTurnItem
              liveEvents={liveEvents}
              persistedTurns={turns}
              provider={providerId}
            />
          )}
        </div>
      </div>
      {showScrollButton && (
        <button type="button" className="session-scroll-bottom-button" onClick={scrollToLatest}>
          <ChevronDown size={14} />
          回到底部
        </button>
      )}
    </div>
  );
}


function RuntimeStatusPill({ running, pendingApproval }) {
  const status = pendingApproval ? 'approval' : running ? 'running' : 'idle';
  const label = pendingApproval ? '等待审批' : running ? 'Agent 正在运行' : '空闲';
  return (
    <span className={`runtime-status-pill ${status}`}>
      <span className="runtime-status-dot" />
      {label}
    </span>
  );
}

function TurnItem({ turn, turnIndex }) {
  const elements = [];
  let currentTools = [];
  let toolGroupIndex = 0;
  let itemIndex = 0;

  for (const item of (turn.items || [])) {
    const itemKey = item.id || `${turnIndex}-${itemIndex}`;
    itemIndex += 1;
    if (item.type === 'userMessage' || item.type === 'agentMessage') {
      if (currentTools.length > 0) {
        elements.push(
          <ToolsCollapsible
            key={`${currentTools[0].item?.id || 'tools'}-${toolGroupIndex}-collapsible`}
            tools={currentTools}
          />,
        );
        currentTools = [];
        toolGroupIndex += 1;
      }
      if (item.type === 'userMessage') {
        elements.push(
          <UserMessageBubble
            key={itemKey}
            item={item}
          />,
        );
      } else {
        elements.push(
          <AgentMessageBubble
            key={itemKey}
            item={item}
          />,
        );
      }
    } else if (isRenderableToolItem(item)) {
      currentTools.push({ item });
    }
  }

  if (currentTools.length > 0) {
    elements.push(
      <ToolsCollapsible
        key={`${currentTools[0].item?.id || 'tools'}-${toolGroupIndex}-collapsible`}
        tools={currentTools}
      />,
    );
  }

  return (
    <div className="turn-container animate-fade-in">
      {elements}
    </div>
  );
}

function ToolsCollapsible({ tools, isLive }) {
  const [isOpen, setIsOpen] = useState(false);
  const normalizedTools = tools.map((tool) => (tool?.item ? tool.item : tool));

  const commandCount = normalizedTools.filter((item) => item.type === 'commandExecution').length;
  const fileCount = normalizedTools.filter((item) => item.type === 'fileChange').length;

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
          {normalizedTools.map((item, idx) => (
            <ToolDetailItem
              key={item.id || idx}
              tool={item}
            />
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
    const files = filesFromFileChangeTool(tool);

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

  const display = toolDisplayForItem(tool);
  if (!display) return null;

  return (
    <div className={`tool-detail-item ${display.kind || 'generic'}`}>
      <div className="generic-tool-card">
        <div className="generic-tool-title">{display.title}</div>
        <pre className="generic-tool-body">{display.body}</pre>
      </div>
    </div>
  );
}

function UserMessageBubble({ item }) {
  const text = textFromUserContent(item.content);
  return (
    <div className="chat-bubble-container user">
      <div className="chat-bubble-content">
        <div className="chat-bubble-body">
          <MarkdownText text={text} />
        </div>
      </div>
    </div>
  );
}

function OptimisticUserMessageBubble({ message }) {
  return (
    <UserMessageBubble
      item={{ type: 'userMessage', content: [{ type: 'input_text', text: message.prompt }] }}
    />
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

function LiveTurnItem({ liveEvents, persistedTurns, provider }) {
  const parsed = useMemo(() => parseLiveSessionEvents(liveEvents, persistedTurns), [liveEvents, persistedTurns]);

  const { tools, agentMessageText, agentMessageDeduped, reasoningText, errorText, approvalPending, activity } = parsed;
  const showThinking = !agentMessageDeduped && !agentMessageText && !errorText;
  const showActivityBanner = shouldShowLiveActivityBanner(parsed);

  return (
    <div className="turn-container active-live">
      {showActivityBanner && (
        <LiveActivityBanner activity={activity} approvalPending={approvalPending} errorText={errorText} provider={provider} />
      )}
      {tools.length > 0 && (
        <ToolsCollapsible
          tools={tools}
          isLive={true}
        />
      )}

      {reasoningText && (
        <div className="live-reasoning-card">
          <span>Reasoning summary</span>
          <p>{reasoningText}</p>
        </div>
      )}

      {showThinking && (
        <div className="chat-bubble-container agent streaming">
          <div className="chat-bubble-avatar agent-logo live-pulse">A</div>
          <div className="chat-bubble-content">
            <div className="chat-bubble-sender">Agent</div>
            <div className="chat-bubble-body thinking-placeholder">
              <span>正在思考中</span>
              <span className="typing-dots"><i></i><i></i><i></i></span>
            </div>
          </div>
        </div>
      )}

      {agentMessageText && (
        <div className="chat-bubble-container agent streaming">
          <div className="chat-bubble-avatar agent-logo live-pulse">A</div>
          <div className="chat-bubble-content">
            <div className="chat-bubble-sender">Agent <span className="streaming-badge">Streaming...</span></div>
            <div className="chat-bubble-body">
              <MarkdownText text={agentMessageText} />
            </div>
          </div>
        </div>
      )}

      {errorText && (
        <span className="sr-only">{errorText}</span>
      )}
    </div>
  );
}

function LiveActivityBanner({ activity, approvalPending, errorText, provider }) {
  const labelName = providerLabel(provider);
  if (errorText) return <div className="live-activity-banner error">{labelName} 运行出错：{errorText}</div>;
  if (approvalPending) return <div className="live-activity-banner approval">{labelName} 已暂停，正在等待网页审批。</div>;
  const label = liveActivityLabel(activity, labelName);
  return <div className="live-activity-banner"><Loader2 size={13} className="spin-animation" /> {label}</div>;
}

function liveActivityLabel(activity, provider) {
  switch (activity) {
    case 'streaming':
      return `${provider} is working · 正在输出回复`;
    case 'command':
      return `${provider} is working · 正在运行命令`;
    case 'file-change':
      return `${provider} is working · 正在整理文件改动`;
    default:
      return 'Agent is running';
  }
}

function MarkdownText({ text }) {
  return <MarkdownPreview text={text || ''} className="session-markdown" />;
}
