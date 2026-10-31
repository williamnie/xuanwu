import { memo, useMemo } from 'react';
import { isRenderableToolItem, parseLiveSessionEvents, liveActivityStatus } from './sessionTranscriptItems';
import { UserMessageBubble, AgentMessageBubble, MessageHeader, MarkdownText } from './SessionMessageContent.jsx';
import { ToolsCollapsible } from './SessionTranscriptTools.jsx';

export const TurnItem = memo(function TurnItem({ turn, turnIndex, provider, model, project, session }) {
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
});

export function ProviderExecutionBlock({ items, model, project, provider, timestamp }) {
  const content = [];
  let tools = [];
  let groupIndex = 0;
  const flushTools = () => {
    if (tools.length === 0) return;
    content.push(<ToolsCollapsible key={`tools-${groupIndex}`} tools={tools} />);
    tools = [];
    groupIndex += 1;
  };
  items.forEach((item, index) => {
    if (item.type === 'agentMessage' && String(item.text || '').trim()) {
      flushTools();
      content.push(<AgentMessageBubble item={item} key={item.id || `message-${index}`} />);
      return;
    }
    tools.push(item);
  });
  flushTools();

  return (
    <div className="session-provider-message">
      <MessageHeader
        avatar={providerAvatar(provider)}
        role={providerIdentity(provider, model)}
        timestamp={timestamp}
      />
      <div className="session-provider-message-body" data-project={project?.name || ''}>
        {content}
      </div>
    </div>
  );
}

export function OptimisticUserMessageBubble({ message }) {
  return (
    <UserMessageBubble
      item={{ type: 'userMessage', content: [{ type: 'input_text', text: message.prompt }] }}
      timestamp={formatTranscriptTime(message.createdAt)}
    />
  );
}

export function LiveTurnItem({ liveEvents, persistedTurns, provider }) {
  const parsed = useMemo(() => parseLiveSessionEvents(liveEvents, persistedTurns), [liveEvents, persistedTurns]);

  const { tools, agentMessageText, reasoningText } = parsed;

  return (
    <div className="turn-container active-live session-provider-message">
      <MessageHeader
        avatar={providerAvatar(provider)}
        role={providerIdentity(provider, '')}
        timestamp={formatTranscriptTime(liveEvents.at(-1)?.created_at || liveEvents.at(-1)?.occurred_at)}
      />
      <ToolsCollapsible tools={tools} liveStatus={liveActivityStatus(parsed)} />

      {reasoningText && (
        <div className="live-reasoning-card">
          <span>Reasoning summary</span>
          <p>{reasoningText}</p>
        </div>
      )}

      {agentMessageText && (
        <div className="session-agent-copy streaming">
          <MarkdownText text={agentMessageText} />
        </div>
      )}
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

const transcriptTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

function formatTranscriptTime(value) {
  if (!value) return '';
  const numeric = typeof value === 'number' ? value : Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1_000_000_000_000 ? numeric * 1000 : numeric)
    : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return transcriptTimeFormatter.format(date);
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
