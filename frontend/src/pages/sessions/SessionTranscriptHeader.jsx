import { providerLabel } from './sessionPageRuntime';
import { useMemo, useCallback } from 'react';
import { codexAppThreadUrl } from './codexAppLink.js';
import { buildSessionResumeCommand, markdownFilenameForSession, sessionToMarkdown } from './sessionMarkdownExport.js';
import { message as toast } from '../../store/toastStore';
import { ExternalLink } from 'lucide-react';
import { CreateSessionIssueButton, SessionInfoPopover } from './SessionInfoPanel';

export function SessionTranscriptHeader({ session, project, running, working, pendingApproval, navigateTo }) {
  const provider = providerLabel(session?.provider);
  const providerSessionId = session?.provider_session_id || session?.sessionId || session?.id || '';
  const codexAppUrl = useMemo(() => codexAppThreadUrl(session), [session]);
  const resume = useMemo(() => buildSessionResumeCommand(session), [session]);
  const model = session?.model || '';
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
      <div className="session-runtime-header">
        <div className="session-runtime-meta">
          <span>Coding tool: {provider}</span>
          <code title={providerSessionId}>{providerSessionId}</code>
        </div>
        <RuntimeStatusPill running={working} pendingApproval={pendingApproval} />
        <div className="session-runtime-actions">
          <div className="session-export-actions">
            {codexAppUrl ? (
              <button type="button" onClick={openCodexApp} title="在 Codex App 中打开当前 Session">
                <ExternalLink size={13} />
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
  );
}

export function RuntimeStatusPill({ running, pendingApproval }) {
  const status = pendingApproval ? 'approval' : running ? 'running' : 'idle';
  const label = pendingApproval ? '等待审批' : running ? 'Agent 正在运行' : '空闲';
  return (
    <span className={`runtime-status-pill ${status}`}>
      <span className="runtime-status-dot" />
      {label}
    </span>
  );
}

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
