import { useState, useId } from 'react';
import { isInspectableToolItem, toolDisplayForItem } from './sessionTranscriptItems';
import { Loader2, CircleAlert, Pause, SlidersHorizontal, ChevronDown, FileCode } from 'lucide-react';
import { projectNameFromPath, filesFromFileChangeTool } from './sessionTranscriptDiff.js';
import { MarkdownText } from './SessionMessageContent.jsx';

export function ToolsCollapsible({ tools, liveStatus }) {
  const [isOpen, setIsOpen] = useState(false);
  const detailsId = useId();
  const normalizedTools = tools.map((tool) => (tool?.item ? tool.item : tool));
  const detailItems = normalizedTools.filter((item) => (
    item?.type === 'agentMessage' || isInspectableToolItem(item)
  ));
  const actionCount = normalizedTools.filter((item) => item?.type !== 'agentMessage').length;
  const progressCount = normalizedTools.length - actionCount;
  const canExpand = detailItems.length > 0;
  const summary = liveStatus?.label || (actionCount > 0
    ? `执行过程 · ${actionCount} 个动作`
    : `执行过程 · ${progressCount} 条进展`);
  const tone = liveStatus?.tone || 'idle';
  const StatusIcon = tone === 'running' ? Loader2
    : tone === 'error' ? CircleAlert
      : tone === 'approval' ? Pause : SlidersHorizontal;

  return (
    <div className="tools-collapsible-wrapper">
      <button
        type="button"
        aria-label={canExpand && liveStatus ? `${summary}，执行详情` : summary}
        aria-expanded={canExpand ? isOpen : undefined}
        aria-controls={canExpand && isOpen ? detailsId : undefined}
        className={`tools-trigger-btn session-execution-summary ${isOpen ? 'open' : ''} ${canExpand ? '' : 'static'}`}
        data-tone={tone}
        disabled={!canExpand}
        onClick={() => canExpand && setIsOpen((open) => !open)}
      >
        <span className="tools-trigger-left">
          <span className="tools-indicator-icon" aria-hidden="true">
            <StatusIcon size={13} className={tone === 'running' ? 'spin-animation' : ''} />
          </span>
          <span className="tools-trigger-text" role={tone === 'error' ? 'alert' : liveStatus ? 'status' : undefined}>
            {summary}
          </span>
        </span>
        {canExpand && (
          <span className="session-execution-details-label">
            {liveStatus ? '执行详情' : null}
            <span className="tools-trigger-chevron" aria-hidden="true">
              <ChevronDown size={14} />
            </span>
          </span>
        )}
      </button>

      {isOpen && canExpand && (
        <div id={detailsId} className="tools-details-content">
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

export function ToolDetailItem({ tool }) {
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
