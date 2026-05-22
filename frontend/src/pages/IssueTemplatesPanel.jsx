import { useState } from 'react';
import { api } from '../api/client';
import { message } from '../store/toastStore';
import {
  selectIssueTemplates,
  selectRefreshAllData,
  useDataStore,
} from '../store/dataStore';
import { FileText, Pencil, Plus, Star, Trash2, X } from 'lucide-react';

const EMPTY_MODAL = {
  open: false,
  mode: 'create',
  id: '',
  name: '',
  content: '',
  isDefault: false,
  error: '',
  saving: false,
};

function defaultTemplateContent(templates) {
  return templates.find(t => t.is_default === 1)?.content || templates[0]?.content || '';
}

export default function IssueTemplatesPanel() {
  const templates = useDataStore(selectIssueTemplates);
  const refreshAllData = useDataStore(selectRefreshAllData);
  const [modal, setModal] = useState(EMPTY_MODAL);

  const openCreateModal = () => {
    setModal({
      ...EMPTY_MODAL,
      open: true,
      content: defaultTemplateContent(templates),
    });
  };

  const openEditModal = (template) => {
    setModal({
      open: true,
      mode: 'edit',
      id: template.id,
      name: template.name,
      content: template.content,
      isDefault: template.is_default === 1,
      error: '',
      saving: false,
    });
  };

  const setField = (field, value) => {
    setModal(current => ({ ...current, [field]: value }));
  };

  const closeModal = () => setModal(EMPTY_MODAL);

  const submitTemplate = async (event) => {
    event.preventDefault();
    if (!modal.name.trim() || !modal.content.trim()) {
      setField('error', '模板名称和内容不能为空');
      return;
    }
    setField('saving', true);
    try {
      const payload = {
        name: modal.name,
        content: modal.content,
        is_default: modal.isDefault ? 1 : 0,
      };
      if (modal.mode === 'create') {
        await api.createIssueTemplate(payload);
      } else {
        await api.updateIssueTemplate(modal.id, payload);
      }
      closeModal();
      await refreshAllData();
    } catch (err) {
      setModal(current => ({ ...current, error: err.message || '保存模板失败', saving: false }));
    }
  };

  const setDefaultTemplate = async (template) => {
    try {
      await api.updateIssueTemplate(template.id, { is_default: 1 });
      await refreshAllData();
    } catch (err) {
      message.error(err.message || '设置默认模板失败');
    }
  };

  const deleteTemplate = async (template) => {
    if (!window.confirm(`确定删除模板「${template.name}」吗？`)) return;
    try {
      await api.deleteIssueTemplate(template.id);
      await refreshAllData();
    } catch (err) {
      message.error(err.message || '删除模板失败');
    }
  };

  return (
    <section className="glass-card" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <FileText size={18} color="var(--primary)" /> Issue 模板
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '4px' }}>
            创建 Issue 时可选择模板；模板内容支持 {'{{project.cwd}}'}、{'{{issue.content}}'}、{'{{issue.title}}'} 等占位符。
          </p>
        </div>
        <button className="btn btn-primary" onClick={openCreateModal} style={{ padding: '7px 12px' }}>
          <Plus size={15} /> 新增模板
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px' }}>
        {templates.map(template => (
          <TemplateCard
            key={template.id}
            template={template}
            onEdit={openEditModal}
            onSetDefault={setDefaultTemplate}
            onDelete={deleteTemplate}
          />
        ))}
      </div>

      {modal.open && (
        <TemplateModal
          modal={modal}
          onClose={closeModal}
          onField={setField}
          onSubmit={submitTemplate}
        />
      )}
    </section>
  );
}

function TemplateCard({ template, onEdit, onSetDefault, onDelete }) {
  const isDefault = template.is_default === 1;
  return (
    <div className="glass-card" style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ fontSize: '0.92rem', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {template.name}
          </h3>
          <code style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{template.id}</code>
        </div>
        {isDefault && (
          <span style={{ color: 'var(--warning)', fontSize: '0.72rem', display: 'flex', gap: '4px', alignItems: 'center', flexShrink: 0 }}>
            <Star size={12} fill="currentColor" /> 默认
          </span>
        )}
      </div>
      <pre style={{
        margin: 0,
        maxHeight: '92px',
        overflow: 'hidden',
        whiteSpace: 'pre-wrap',
        color: 'var(--text-secondary)',
        background: 'rgba(0,0,0,0.04)',
        borderRadius: '8px',
        padding: '10px',
        fontSize: '0.72rem',
        lineHeight: 1.45,
      }}>{template.content}</pre>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px' }}>
        {!isDefault && (
          <button className="btn btn-secondary" style={{ padding: '5px 8px', fontSize: '0.72rem' }} onClick={() => onSetDefault(template)}>
            设为默认
          </button>
        )}
        <button className="btn btn-secondary" style={{ padding: '5px 8px' }} onClick={() => onEdit(template)}>
          <Pencil size={12} />
        </button>
        <button className="btn btn-secondary btn-danger" style={{ padding: '5px 8px' }} onClick={() => onDelete(template)}>
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

function TemplateModal({ modal, onClose, onField, onSubmit }) {
  return (
    <div className="modal-overlay">
      <div className="glass-card modal-content" style={{ maxWidth: '720px', padding: '28px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' }}>
          <h2 style={{ fontSize: '1.2rem', fontWeight: 700 }}>
            {modal.mode === 'create' ? '新增 Issue 模板' : '编辑 Issue 模板'}
          </h2>
          <button style={{ background: 'transparent', color: 'var(--text-muted)' }} onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {modal.error && (
            <div style={{ color: 'var(--error)', background: 'var(--error-bg)', padding: '9px 12px', borderRadius: '8px', fontSize: '0.82rem' }}>
              {modal.error}
            </div>
          )}

          <div className="form-group">
            <label>模板名称 *</label>
            <input className="form-control" value={modal.name} onChange={(e) => onField('name', e.target.value)} placeholder="例如：Bug 修复 / 功能开发 / 文档更新" />
          </div>

          <div className="form-group">
            <label>Prompt 模板内容 *</label>
            <textarea
              className="form-control"
              rows={14}
              value={modal.content}
              onChange={(e) => onField('content', e.target.value)}
              style={{ resize: 'vertical', fontFamily: 'var(--font-mono, monospace)', fontSize: '0.78rem' }}
            />
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              可用占位符：{'{{project.id}}'}、{'{{project.name}}'}、{'{{project.cwd}}'}、{'{{issue.id}}'}、{'{{issue.content}}'}、{'{{issue.title}}'}、{'{{issue.description}}'}、{'{{issue.priority}}'}
            </span>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '0.82rem' }}>
            <input type="checkbox" checked={modal.isDefault} onChange={(e) => onField('isDefault', e.target.checked)} />
            保存后设为默认模板
          </label>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>取消</button>
            <button type="submit" className="btn btn-primary" disabled={modal.saving}>
              {modal.saving ? '保存中...' : '保存模板'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
