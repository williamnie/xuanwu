import { ChevronDown, ChevronsDown, ChevronsUp, MessageCircleMore, Paperclip, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { assistantApi } from '../api/assistant.js';
import { workApi } from '../api/work.js';
import { PRODUCT_NAV_LABELS } from '../brand.js';
import SessionComposer from '../pages/sessions/SessionComposer.jsx';
import { selectProjects, useDataStore } from '../store/dataStore.js';
import { message } from '../store/toastStore.js';
import {
  GLOBAL_COMPOSER_PERMISSION_MODES,
  addGlobalComposerReference,
  attachGlobalComposerPageReference,
  buildGlobalComposerPageReference,
  buildGlobalComposerReferenceDetails,
  buildGlobalComposerSubmission,
  buildGlobalComposerSuggestions,
  isGlobalAskComposerVisible,
  removeGlobalComposerReference,
  syncGlobalComposerPageReference,
} from './globalAskComposerModel.js';
import './GlobalAskComposer.css';

const GLOBAL_COMPOSER_SETTINGS = {
  approvalPolicy: 'danger-only',
  model: '',
  reasoningEffort: '',
  sandbox: 'workspace-write',
};

export default function GlobalAskComposer({
  currentPage,
  filterProject = '',
  onConversationReady,
  onOpenAskXuanwu,
  pageContext = null,
  selectedHandoffId = '',
  selectedIssueId = null,
  selectedRunId = '',
  selectedSessionId = '',
}) {
  const projects = useDataStore(selectProjects);
  const [works, setWorks] = useState([]);
  const [prompt, setPrompt] = useState('');
  const [permissionMode, setPermissionMode] = useState('controlled');
  const [sending, setSending] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const visible = isGlobalAskComposerVisible(currentPage);
  const pageReference = useMemo(() => buildGlobalComposerPageReference({
    currentPage,
    filterProject,
    pageContext,
    selectedHandoffId,
    selectedIssueId,
    selectedRunId,
    selectedSessionId,
  }, works), [
    currentPage,
    filterProject,
    pageContext,
    selectedHandoffId,
    selectedIssueId,
    selectedRunId,
    selectedSessionId,
    works,
  ]);
  const [references, setReferences] = useState(() => [pageReference]);

  useEffect(() => {
    let active = true;
    workApi.getWorks()
      .then(response => {
        if (active) setWorks(response?.items || []);
      })
      .catch(() => {
        // Work mentions degrade to project/page context; the composer itself remains usable.
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    setReferences(current => syncGlobalComposerPageReference(current, prompt, pageReference));
  }, [pageReference, prompt]);

  const suggestions = useMemo(
    () => buildGlobalComposerSuggestions(projects, works),
    [projects, works],
  );
  const referenceDetails = useMemo(
    () => buildGlobalComposerReferenceDetails(references, projects, works),
    [projects, references, works],
  );
  const attachedPage = references.find(reference => reference.type === 'page');
  const pageContextCurrent = attachedPage?.key === pageReference.key;

  if (!visible) return null;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (sending || !prompt.trim()) return;
    setSending(true);
    try {
      const submission = buildGlobalComposerSubmission({ permissionMode, prompt, references });
      const conversation = await assistantApi.createPiConversation(submission.conversation);
      await assistantApi.sendPiConversationMessage(conversation.id, submission.message);
      setPrompt('');
      setReferences([pageReference]);
      message.success('已发送给 Xuanwu Supervisor');
      onConversationReady?.(conversation.id);
    } catch (error) {
      message.error(error.message || '发送 Supervisor 消息失败');
    } finally {
      setSending(false);
    }
  };

  const runtimeControls = (
    <GlobalComposerControls
      attached={Boolean(attachedPage)}
      contextCurrent={pageContextCurrent}
      onAttachPage={() => setReferences(current => attachGlobalComposerPageReference(current, pageReference))}
      onPermissionModeChange={setPermissionMode}
      permissionMode={permissionMode}
    />
  );

  return (
    <aside
      aria-label="Global Ask Xuanwu composer"
      className={`global-ask-composer-shell ${expanded ? 'expanded' : 'collapsed'}`}
    >
      <div className="global-ask-composer-card">
        <header className="global-ask-composer-header">
          <button className="global-ask-composer-brand" onClick={onOpenAskXuanwu} type="button">
            <span className="global-ask-composer-mark"><MessageCircleMore size={15} /></span>
            <span>
              <strong>{PRODUCT_NAV_LABELS.askXuanwu}</strong>
              <small>{prompt.trim() ? 'Draft retained across pages' : 'Context-aware Supervisor'}</small>
            </span>
          </button>
          <button
            aria-label={expanded ? '收起全局 Ask Xuanwu 输入框' : '展开全局 Ask Xuanwu 输入框'}
            className="global-ask-composer-toggle"
            onClick={() => setExpanded(value => !value)}
            type="button"
          >
            {expanded ? <ChevronsDown size={16} /> : <ChevronsUp size={16} />}
          </button>
        </header>
        {expanded ? (
          <SessionComposer
            interruptState={null}
            models={[]}
            modelsError=""
            modelsLoading={false}
            onAttachReference={reference => setReferences(current => addGlobalComposerReference(current, reference))}
            onChange={setPrompt}
            onRemoveReference={key => setReferences(current => removeGlobalComposerReference(current, key))}
            onSettingChange={() => {}}
            onStop={() => {}}
            onSubmit={handleSubmit}
            placeholder="Ask Xuanwu… 输入 @ 选择项目或 Work"
            referenceDetails={referenceDetails}
            requirePrompt
            running={false}
            runtimeControls={runtimeControls}
            selectedId="global-xuanwu-composer"
            sending={sending}
            settings={GLOBAL_COMPOSER_SETTINGS}
            suggestions={suggestions}
            value={prompt}
          />
        ) : null}
      </div>
    </aside>
  );
}

function GlobalComposerControls({
  attached,
  contextCurrent,
  onAttachPage,
  onPermissionModeChange,
  permissionMode,
}) {
  const selected = GLOBAL_COMPOSER_PERMISSION_MODES.find(mode => mode.value === permissionMode)
    || GLOBAL_COMPOSER_PERMISSION_MODES[0];
  return (
    <>
      <button
        className={`global-composer-context-control ${attached && contextCurrent ? 'attached' : ''}`}
        onClick={onAttachPage}
        title={attached && !contextCurrent ? '把草稿上下文更新到当前页面' : '附加当前页面上下文与 provenance'}
        type="button"
      >
        <Paperclip size={13} />
        <span>{attached ? (contextCurrent ? '页面已附加' : '更新页面') : '附加页面'}</span>
      </button>
      <label className="session-composer-select permission" title="Supervisor 权限模式；确定性门禁仍是最终 authority">
        <ShieldCheck size={14} />
        <span className="session-composer-select-value">{selected.label}</span>
        <select
          aria-label="Supervisor 权限模式"
          onChange={event => onPermissionModeChange(event.target.value)}
          value={selected.value}
        >
          {GLOBAL_COMPOSER_PERMISSION_MODES.map(mode => (
            <option key={mode.value} value={mode.value}>{mode.label}</option>
          ))}
        </select>
        <ChevronDown className="session-composer-chevron" size={13} />
      </label>
    </>
  );
}
