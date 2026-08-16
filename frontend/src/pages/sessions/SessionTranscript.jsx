import { useCallback, useMemo, useState } from 'react';
import { ChevronDown, ExternalLink, FileCode, Loader2, SlidersHorizontal } from 'lucide-react';
import MarkdownPreview from '../../components/editor/MarkdownPreview';
import { message as toast } from '../../store/toastStore';
import SessionCommandReplay from './SessionCommandReplay.js';
import { codexAppThreadUrl } from './codexAppLink.js';
import { buildSessionResumeCommand, markdownFilenameForSession, sessionToMarkdown } from './sessionMarkdownExport.js';
import { providerLabel } from './sessionPageRuntime';
import {
  isRenderableToolItem,
  isInspectableToolItem,
  parseLiveSessionEvents,
  shouldRenderLiveTurn,
  shouldShowLiveActivityBanner,
  toolDisplayForItem,
} from './sessionTranscriptItems';
import { useSmartAutoScroll } from './smartAutoScroll';
import { textFromUserContent } from './sourceIssue';
import { CreateSessionIssueButton, SessionInfoPopover } from './SessionInfoPanel';
import './SessionCommandReplay.css';
import './SessionTranscript.css';

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
              provider={providerId}
              model={model}
              project={project}
              session={session}
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

function TurnItem({ turn, turnIndex, provider, model, project, session }) {
  const elements = [];
  let providerItems = [];
  let providerBlockIndex = 0;
  let itemIndex = 0;

  const flushProviderItems = () => {
    if (providerItems.length === 0) return;
    elements.push(
      <ProviderExecutionBlock
        key={`${turn.id || turnIndex}-provider-${providerBlockIndex}`}
        items={providerItems}
        model={model}
        project={project}
        provider={provider}
        timestamp={turnTimestamp(turn, session, 'agent')}
      />,
    );
    providerItems = [];
    providerBlockIndex += 1;
  };

  for (const item of (turn.items || [])) {
    const itemKey = item.id || `${turnIndex}-${itemIndex}`;
    itemIndex += 1;
    if (item.type === 'userMessage') {
      flushProviderItems();
      elements.push(
        <UserMessageBubble
          key={itemKey}
          item={item}
          timestamp={turnTimestamp(turn, session, 'user')}
        />,
      );
    } else if (item.type === 'agentMessage' || isRenderableToolItem(item)) {
      providerItems.push(item);
    }
  }

  flushProviderItems();

  return (
    <div className="turn-container animate-fade-in">
      {elements}
    </div>
  );
}

function ProviderExecutionBlock({ items, model, project, provider, timestamp }) {
  const finalMessageIndex = items.findLastIndex((item) => item.type === 'agentMessage' && String(item.text || '').trim());
  const finalMessage = finalMessageIndex >= 0 ? items[finalMessageIndex] : null;
  const processItems = items.filter((_, index) => index !== finalMessageIndex);

  return (
    <div className="session-provider-message">
      <MessageHeader
        avatar={providerAvatar(provider)}
        role={providerIdentity(provider, model)}
        timestamp={timestamp}
      />
      <div className="session-provider-message-body" data-project={project?.name || ''}>
        {processItems.length > 0 && <ToolsCollapsible tools={processItems} />}
        {finalMessage && <AgentMessageBubble item={finalMessage} />}
      </div>
    </div>
  );
}

function ToolsCollapsible({ tools, isLive }) {
  const [isOpen, setIsOpen] = useState(Boolean(isLive));
  const normalizedTools = tools.map((tool) => (tool?.item ? tool.item : tool));
  const detailItems = normalizedTools.filter((item) => (
    item?.type === 'agentMessage' || isInspectableToolItem(item)
  ));
  const actionCount = normalizedTools.filter((item) => item?.type !== 'agentMessage').length;
  const progressCount = normalizedTools.length - actionCount;
  const latestTool = normalizedTools.filter((item) => item?.type !== 'agentMessage').at(-1);
  const canExpand = detailItems.length > 0;
  const summary = isLive
    ? `正在执行工具 · ${toolSummaryLabel(latestTool)}`
    : actionCount > 0
      ? `执行过程 · ${actionCount} 个动作`
      : `执行过程 · ${progressCount} 条进展`;

  return (
    <div className="tools-collapsible-wrapper">
      <button
        aria-expanded={canExpand ? isOpen : undefined}
        className={`tools-trigger-btn ${isOpen ? 'open' : ''} ${isLive ? 'live' : ''} ${canExpand ? '' : 'static'}`}
        disabled={!canExpand}
        onClick={() => canExpand && setIsOpen(!isOpen)}
      >
        <span className="tools-trigger-left">
          <span className="tools-indicator-icon">
            <SlidersHorizontal size={13} className={isLive ? 'spin-animation' : ''} />
          </span>
          <span className="tools-trigger-text">{summary}</span>
        </span>
        {canExpand && (
          <span className="tools-trigger-chevron">
            <ChevronDown size={14} />
          </span>
        )}
      </button>

      {isOpen && canExpand && (
        <div className="tools-details-content animate-slide-down">
          {detailItems.map((item, idx) => item.type === 'agentMessage' ? (
            <div className="session-process-note" key={item.id || idx}>
              <MarkdownText text={item.text || ''} />
            </div>
          ) : (
            <ToolDetailItem key={item.id || idx} tool={item} />
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
            <div className="diff-file-body session-transcript-empty-diff">
              {diffText ? (
                <pre className="session-transcript-empty-diff__text">{diffText}</pre>
              ) : (
                <span className="session-transcript-empty-diff__placeholder">无具体的代码差异（可能是新增空白文件、修改文件属性或未完成保存）</span>
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

function UserMessageBubble({ item, timestamp }) {
  const text = textFromUserContent(item.content);
  return (
    <div className="chat-bubble-container user session-user-message">
      <div className="chat-bubble-content">
        <MessageHeader avatar="IN" role="任务输入" timestamp={timestamp} />
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
      timestamp={formatTranscriptTime(message.createdAt)}
    />
  );
}

function AgentMessageBubble({ item }) {
  const text = item.text || '';
  return (
    <div className="session-agent-copy animate-fade-in">
      <MarkdownText text={text} />
    </div>
  );
}

function LiveTurnItem({ liveEvents, persistedTurns, provider }) {
  const parsed = useMemo(() => parseLiveSessionEvents(liveEvents, persistedTurns), [liveEvents, persistedTurns]);

  const { tools, agentMessageText, agentMessageDeduped, reasoningText, errorText, approvalPending, activity } = parsed;
  const showThinking = !agentMessageDeduped && !agentMessageText && !errorText;
  const showActivityBanner = shouldShowLiveActivityBanner(parsed);

  return (
    <div className="turn-container active-live session-provider-message">
      <MessageHeader
        avatar={providerAvatar(provider)}
        role={providerIdentity(provider, '')}
        timestamp={formatTranscriptTime(liveEvents.at(-1)?.created_at || liveEvents.at(-1)?.occurred_at)}
      />
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
        <div className="session-agent-copy thinking-placeholder">
          <span>正在思考中</span>
          <span className="typing-dots"><i></i><i></i><i></i></span>
        </div>
      )}

      {agentMessageText && (
        <div className="session-agent-copy streaming">
          <span className="streaming-badge">Streaming...</span>
          <MarkdownText text={agentMessageText} />
        </div>
      )}

      {errorText && (
        <span className="sr-only">{errorText}</span>
      )}
    </div>
  );
}

function MessageHeader({ avatar, role, timestamp }) {
  return (
    <div className="session-message-head">
      <span className="session-message-avatar">{avatar}</span>
      <span className="session-message-role">{role}</span>
      {timestamp ? <time className="session-message-time">{timestamp}</time> : null}
    </div>
  );
}

function providerAvatar(provider) {
  const value = String(provider || '').toLowerCase();
  if (value.includes('codex')) return 'CX';
  if (value.includes('qoder')) return 'QD';
  if (value.includes('claude')) return 'CL';
  if (value.includes('pi')) return 'PI';
  return value.slice(0, 2).toUpperCase() || 'AI';
}

function providerIdentity(provider, model) {
  const providerText = String(provider || 'agent').toLowerCase();
  const modelText = String(model || '').trim();
  return modelText ? `${providerText} · ${modelText}` : providerText;
}

function formatTranscriptTime(value) {
  if (!value) return '';
  const numeric = typeof value === 'number' ? value : Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric)
    : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function turnTimestamp(turn, session, role) {
  const turnValue = role === 'user'
    ? turn?.created_at || turn?.createdAt || turn?.started_at || turn?.startedAt
    : turn?.completed_at || turn?.completedAt || turn?.updated_at || turn?.updatedAt;
  const sessionValue = role === 'user'
    ? session?.createdAt || session?.created_at
    : session?.updatedAt || session?.updated_at;
  return formatTranscriptTime(turnValue || sessionValue);
}

function toolSummaryLabel(tool) {
  if (!tool) return 'Tool';
  if (/^mcpTool(?:Call|Result)$/i.test(String(tool.type || ''))) return '后台动作';
  if (tool.type === 'commandExecution') return tool.command || 'Terminal';
  if (tool.type === 'fileChange') {
    const file = filesFromFileChangeTool(tool).at(-1);
    return file?.path ? `Edit ${file.path}` : 'Edit files';
  }
  const display = toolDisplayForItem(tool);
  return display?.title || tool.type || 'Tool';
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
