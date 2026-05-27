import { useEffect, useState } from 'react';
import { Save, X } from 'lucide-react';
import { api } from '../api/client';
import PromptEditor from './editor/PromptEditor';
import {
  canEditIssue,
  issueDraftToPatch,
  issueToEditDraft,
  validateIssueDraft,
} from '../utils/issueEdit';
import {
  REFINEMENT_RECOMMENDATION_FIELDS,
  REFINEMENT_SPEC_FIELDS,
  issueRefinementReadiness,
} from '../utils/issueRefinement';

const PRIORITY_OPTIONS = [
  { value: '0', label: '普通优先级' },
  { value: '1', label: '中优先级' },
  { value: '2', label: '紧急插队 (High)' },
];

export default function IssueEditModal({ issue, initialRefinement, onClose, onSaved }) {
  const [draft, setDraft] = useState(() => issueToEditDraftWithRefinement(issue, initialRefinement));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(issueToEditDraftWithRefinement(issue, initialRefinement));
    setError('');
    setSaving(false);
  }, [issue, initialRefinement]);

  const setField = (field, value) => {
    setDraft(current => ({ ...current, [field]: value }));
  };

  const setRefinementField = (field, value) => {
    setDraft(current => ({
      ...current,
      refinement: { ...current.refinement, [field]: value },
    }));
  };

  const submitEdit = async (event) => {
    event.preventDefault();
    const validationError = editValidationError(issue, draft);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const updatedIssue = await api.updateIssue(issue.id, issueDraftToPatch(draft));
      onSaved(updatedIssue);
    } catch (err) {
      setError(err.message || '保存 Issue 失败');
      setSaving(false);
    }
  };

  if (!canEditIssue(issue)) return null;

  return (
    <div className="modal-overlay">
      <div className="glass-card modal-content" style={{ maxWidth: '780px', padding: '24px', maxHeight: 'calc(100vh - 48px)', overflowY: 'auto' }}>
        <ModalHeader issue={issue} onClose={onClose} />
        <form onSubmit={submitEdit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {error && <EditError message={error} />}
          <TitleField value={draft.title} onChange={(value) => setField('title', value)} />
          <DescriptionField value={draft.description} onChange={(value) => setField('description', value)} />
          <RefinementFields draft={draft.refinement} onChange={setRefinementField} />
          <PriorityField value={draft.priority} onChange={(value) => setField('priority', value)} />
          <ModalActions saving={saving} onClose={onClose} />
        </form>
      </div>
    </div>
  );
}

function issueToEditDraftWithRefinement(issue, refinement) {
  const draft = issueToEditDraft(issue);
  if (!refinement) return draft;
  return { ...draft, refinement: { ...draft.refinement, ...refinement } };
}

function editValidationError(issue, draft) {
  if (!canEditIssue(issue)) {
    return '只有 Triage 状态的 Issue 可以编辑';
  }
  return validateIssueDraft(draft);
}

function ModalHeader({ issue, onClose }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' }}>
      <div>
        <h3 style={{ fontSize: '1.12rem', fontWeight: 700 }}>编辑 Triage Issue #{issue.id}</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', marginTop: '4px' }}>
          修改会直接保存到运行前的 Issue 内容；进入 Todo / In Progress 后不再开放编辑。
        </p>
      </div>
      <button type="button" style={{ background: 'transparent', color: 'var(--text-muted)', border: 'none', cursor: 'pointer' }} onClick={onClose}>
        <X size={18} />
      </button>
    </div>
  );
}

function TitleField({ value, onChange }) {
  return (
    <div className="form-group">
      <label>任务标题（可选，留空会从内容首行自动生成）</label>
      <input
        type="text"
        className="form-control"
        placeholder="例如：修复 Triage issue 编辑入口"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function DescriptionField({ value, onChange }) {
  return (
    <div className="form-group">
      <label>任务内容 / 需求描述 *</label>
      <PromptEditor
        placeholder="更新要 Codex 执行的完整内容，例如复现路径、期望改动和验证方式..."
        value={value}
        onChange={onChange}
        minHeight={160}
        hideToolbar={true}
      />
    </div>
  );
}

function RefinementFields({ draft, onChange }) {
  const readiness = issueRefinementReadiness(draft);
  return (
    <section style={{ border: '1px solid var(--border-color)', borderRadius: '12px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div>
        <label style={{ display: 'block', marginBottom: '4px' }}>Refinement</label>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', margin: 0 }}>
          保存后会写入 Issue 描述的 Markdown 区块，后续执行 prompt 会带上这些规格。
        </p>
      </div>
      {!readiness.ready && (
        <div style={{ color: 'var(--warning)', background: 'rgba(245,158,11,0.1)', padding: '8px 10px', borderRadius: '8px', fontSize: '0.78rem' }}>
          Ready 条件：至少补齐 {readiness.missing.join('、')}。
        </div>
      )}
      <RefinementFieldGroup fields={REFINEMENT_SPEC_FIELDS} draft={draft} onChange={onChange} />
      <div>
        <label style={{ display: 'block', marginBottom: '4px' }}>Execution recommendation</label>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', margin: 0 }}>
          只保存 PI Agent 推荐，不会自动选择 provider/profile 或改变 issue 状态。
        </p>
      </div>
      <RefinementFieldGroup fields={REFINEMENT_RECOMMENDATION_FIELDS} draft={draft} onChange={onChange} />
    </section>
  );
}

function RefinementFieldGroup({ fields, draft, onChange }) {
  return fields.map(field => (
    <div className="form-group" key={field.id}>
      <label>{field.label}</label>
      <textarea
        className="form-control"
        value={draft?.[field.id] || ''}
        rows={field.id === 'context' || field.id === 'recommendationReasoning' ? 3 : 2}
        onChange={(event) => onChange(field.id, event.target.value)}
        placeholder={refinementPlaceholder(field.id)}
        style={{ resize: 'vertical' }}
      />
    </div>
  ));
}

function refinementPlaceholder(field) {
  const placeholders = {
    problem: '要解决的问题是什么？当前行为 vs 期望行为是什么？',
    context: '相关路径、入口、API、日志或运行态证据，一行一个。',
    acceptanceCriteria: '可验收的结果，一行一条。',
    verificationPlan: '最小验证命令或手工验证步骤，一行一条。',
    nonGoals: '明确不做的范围，避免执行时扩大。',
    risks: '风险、待澄清问题或阻塞条件。',
    recommendedProfile: '例如 codex-dev / readonly-verifier；不存在则标注为建议。',
    recommendedProvider: '例如 codex；未接入 provider 只能作为建议，不可假装可用。',
    riskLevel: 'Low / Medium / High。',
    recommendationReasoning: '为什么这个 profile/provider 适合该任务。',
    needsHumanConfirmation: 'Yes / No；默认推荐 Yes。',
  };
  return placeholders[field] || '';
}

function PriorityField({ value, onChange }) {
  return (
    <div className="form-group">
      <label>任务优先级</label>
      <select className="form-control" value={value} onChange={(event) => onChange(event.target.value)}>
        {PRIORITY_OPTIONS.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </div>
  );
}

function EditError({ message }) {
  return (
    <div style={{ color: 'var(--error)', background: 'var(--error-bg)', padding: '8px 12px', borderRadius: '6px', fontSize: '0.78rem' }}>
      {message}
    </div>
  );
}

function ModalActions({ saving, onClose }) {
  return (
    <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '10px' }}>
      <button type="button" className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={onClose} disabled={saving}>
        取消
      </button>
      <button type="submit" className="btn btn-primary" style={{ padding: '6px 16px' }} disabled={saving}>
        <Save size={14} /> {saving ? '保存中...' : '保存修改'}
      </button>
    </div>
  );
}
