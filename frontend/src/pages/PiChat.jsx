import { Bot, Loader2, MessageSquarePlus, RefreshCw, Settings2 } from 'lucide-react';
import MarkdownPreview from '../components/editor/MarkdownPreview';
import SessionComposer from './sessions/SessionComposer';
import PiChatComposerMeta from './PiChatComposerMeta';
import { buildPiChatProjectSuggestions, buildPiChatReferenceDetails } from './piChatComposer';
import { projectFromPrompt } from './piChatProjectContext';
import PiActionAuditPanel from './PiActionAuditPanel';
import { shortId, usePiChatState } from './piChatState';
import './PiChat.css';
import './PiChatSidebar.css';
import './PiChatThread.css';

export default function PiChat({ navigateTo }) {
  const state = usePiChatState();
  return <PiChatLayout navigateTo={navigateTo} state={state} />;
}

function PiChatLayout({ navigateTo, state }) {
  return (
    <div className="pi-chat-page animate-fade-in">
      <section className="pi-chat-shell">
        <PiChatSidebar navigateTo={navigateTo} state={state} />
        <PiChatMain navigateTo={navigateTo} state={state} />
      </section>
    </div>
  );
}

function PiChatSidebar({ navigateTo, state }) {
  return (
    <aside className="pi-chat-sidebar glass-card">
      <PiChatSidebarHeader
        loading={state.loading}
        navigateTo={navigateTo}
        onRefresh={state.loadPiState}
      />
      <AgentSelect agents={state.agents} selected={state.selectedAgentId} onChange={state.setSelectedAgentId} />
      <AgentStatus agent={state.selectedAgent} />
      <PiActionAuditPanel />
      <button className="btn btn-primary" onClick={state.handleCreateConversation} disabled={state.sending || !state.selectedAgentId}>
        <MessageSquarePlus size={15} /> 新建 Runner 会话
      </button>
      <ConversationList
        conversations={state.conversations}
        selectedId={state.selectedConversationId}
        onSelect={state.handleConversationChange}
      />
    </aside>
  );
}

function PiChatSidebarHeader({ loading, navigateTo, onRefresh }) {
  return (
    <div className="pi-chat-sidebar-header">
      <div className="pi-chat-sidebar-brand">
        <span className="pi-chat-sidebar-icon"><Bot size={16} /></span>
        <div>
          <strong>Runner</strong>
          <span>Global agent chat</span>
        </div>
      </div>
      <div className="pi-chat-sidebar-actions">
        <button className="pi-chat-icon-button" onClick={onRefresh} disabled={loading} title="刷新 Runner 会话">
          <RefreshCw size={15} className={loading ? 'spin-animation' : ''} />
        </button>
        <button className="pi-chat-icon-button" onClick={() => navigateTo('settings')} title="Runner 设置">
          <Settings2 size={15} />
        </button>
      </div>
    </div>
  );
}

function PiChatMain({ navigateTo, state }) {
  return (
    <main className="pi-chat-main glass-card">
      {state.error && <div className="pi-chat-error">{state.error}</div>}
      {!state.error && state.loading ? <LoadingState /> : (
        <>
          <ChatHeader state={state} />
          <ChatThread navigateTo={navigateTo} state={state} />
          <ChatComposer state={state} />
        </>
      )}
    </main>
  );
}

function ChatHeader({ state }) {
  const title = state.selectedConversation?.title || 'New conversation';
  const count = state.transcript.length;
  return (
    <header className="pi-chat-main-header">
      <div>
        <span>Agent chat</span>
        <strong>{title}</strong>
      </div>
      <small>{count} message{count === 1 ? '' : 's'}</small>
    </header>
  );
}

function AgentSelect({ agents, onChange, selected }) {
  return (
    <label className="pi-chat-field">
      <span>Runner Agent</span>
      <select className="form-control" value={selected} onChange={(event) => onChange(event.target.value)}>
        <option value="">未选择</option>
        {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name || agent.id}</option>)}
      </select>
    </label>
  );
}

function ConversationList({ conversations, onSelect, selectedId }) {
  return (
    <div className="pi-chat-conversation-list">
      <div className="pi-chat-sidebar-title">Conversations</div>
      {conversations.length === 0 ? <div className="pi-chat-empty-mini">暂无 Runner 会话</div> : (
        conversations.map((conversation) => (
          <button
            key={conversation.id}
            className={`pi-chat-conversation ${selectedId === conversation.id ? 'active' : ''}`}
            onClick={() => onSelect(conversation.id)}
          >
            <span>{conversation.title || conversation.id}</span>
            <small>{shortId(conversation.pi_session_id || conversation.id)}</small>
          </button>
        ))
      )}
    </div>
  );
}

function ChatThread({ navigateTo, state }) {
  return (
    <div className="pi-chat-thread">
      {state.transcript.length === 0 ? (
        <EmptyChat navigateTo={navigateTo} hasAgents={state.agents.length > 0} />
      ) : state.transcript.map((item) => <ChatBubble key={item.id} item={item} />)}
      {state.sending && <div className="pi-chat-thinking"><Loader2 className="spin-animation" size={14} /> Runner 正在思考...</div>}
    </div>
  );
}

const PI_CHAT_COMPOSER_SETTINGS = { model: '', reasoningEffort: '', approvalPolicy: 'never', sandbox: 'workspace-write' };

function ChatComposer({ state }) {
  return (
    <div className="pi-chat-composer">
      <SessionComposer
        value={state.prompt}
        onChange={state.setPrompt}
        settings={PI_CHAT_COMPOSER_SETTINGS}
        onSettingChange={() => {}}
        models={[]}
        modelsLoading={false}
        modelsError=""
        sending={state.sending}
        running={false}
        interruptState={null}
        selectedId={state.selectedConversationId || 'runner-draft'}
        placeholder="@项目后直接说需求，例如：@codex-issue-runner 创建一个 issue，修复 Runner Chat 输入体验..."
        onSubmit={state.handleSend}
        suggestions={buildPiChatProjectSuggestions(state.projects)}
        referenceDetails={buildPiChatReferenceDetails(state.references, state.projects)}
        onAttachReference={state.attachReference}
        onRemoveReference={state.removeReference}
        runtimeControls={<PiChatComposerMeta agent={state.selectedAgent} project={state.selectedProject || projectFromPrompt(state.prompt, state.projects)} />}
        onStop={() => {}}
      />
    </div>
  );
}

function AgentStatus({ agent }) {
  if (!agent) return <div className="pi-chat-agent-status warning">未配置可用 Runner Agent</div>;
  return (
    <div className="pi-chat-agent-status">
      <Bot size={14} />
      <div>
        <strong>{agent.model_provider || 'provider 未设'}</strong>
        <span>{agent.model_id || 'model 未设'} · {agent.enabled ? 'enabled' : 'disabled'}</span>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="pi-chat-empty">
      <Loader2 className="spin-animation" size={22} />
      正在读取 Runner 会话...
    </div>
  );
}

function EmptyChat({ hasAgents, navigateTo }) {
  return (
    <div className="pi-chat-empty">
      <Bot size={34} />
      <strong>{hasAgents ? '开始一次 Runner 对话' : '先配置 Runner Agent'}</strong>
      <span>{hasAgents ? '输入 @ 选择项目，然后自然语言告诉 PI 要创建/梳理什么 issue。' : 'Settings 里填写 provider、API path、API key 和模型后即可聊天。'}</span>
      {!hasAgents && <button className="btn btn-secondary" onClick={() => navigateTo('settings')}>打开 Runner 设置</button>}
    </div>
  );
}

function ChatBubble({ item }) {
  return (
    <article className={`pi-chat-bubble ${item.role}`}>
      <div className="pi-chat-bubble-role">{item.role === 'assistant' ? 'Runner' : item.role === 'error' ? 'Error' : 'You'}</div>
      <MarkdownPreview text={item.text} className="pi-chat-markdown" />
      {item.meta?.pi_session_id && <div className="pi-chat-bubble-meta">session {shortId(item.meta.pi_session_id)}</div>}
    </article>
  );
}
