import { automationApi } from '../api/automation.js';
import { useEffect, useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';

export default function SourcePoliciesPanel() {
  const [state, setState] = useState({ data: null, error: '', loading: true });
  useEffect(() => { loadPolicies(setState); }, []);
  return (
    <section className="glass-card" style={{ display: 'grid', gap: '16px' }}>
      <PanelHeader loading={state.loading} onRefresh={() => loadPolicies(setState)} />
      {state.error && <div style={{ color: 'var(--error)', fontSize: '0.86rem' }}>{state.error}</div>}
      <PolicyLayers layers={state.data?.layers || []} />
      <div style={{ display: 'grid', gap: '12px' }}>
        <strong style={{ fontSize: '0.88rem' }}>Read-only source profiles</strong>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          {(state.data?.profiles || []).map((profile) => (
            <span key={profile.id} style={pillStyle()}>{profile.id} · {profile.policy?.action_mode}</span>
          ))}
        </div>
        <small style={{ color: 'var(--text-muted)' }}>
          W2 起 Automation 的权限由 permission_policy_ref 管理；旧 pi_automations policy-only 写入已退役。
        </small>
      </div>
    </section>
  );
}

function PanelHeader({ loading, onRefresh }) {
  return (
    <div style={{ alignItems: 'center', display: 'flex', gap: '14px', justifyContent: 'space-between' }}>
      <div>
        <h2 style={{ alignItems: 'center', display: 'flex', fontSize: '1.1rem', fontWeight: 700, gap: '8px' }}>
          <ShieldCheck size={18} color="var(--primary)" /> Source Policy
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', marginTop: '4px' }}>
          Source profile 作为只读 intake 默认值；Automation 使用统一权限策略。
        </p>
      </div>
      <button className="btn btn-secondary" disabled={loading} onClick={onRefresh} type="button">
        <RefreshCw size={15} className={loading ? 'spin-animation' : ''} /> 刷新
      </button>
    </div>
  );
}

function PolicyLayers({ layers }) {
  if (!layers.length) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
      {layers.map((layer, index) => <span key={layer.scope} style={pillStyle()}>{index + 1}. {layer.scope}</span>)}
    </div>
  );
}

function loadPolicies(setState) {
  setState((previous) => ({ ...previous, loading: true }));
  automationApi.getPiSourcePolicies()
    .then((data) => setState({ data, error: '', loading: false }))
    .catch((error) => setState((previous) => ({ ...previous, error: error.message || '读取 source policies 失败', loading: false })));
}

function pillStyle() {
  return {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius-xs)',
    color: 'var(--text-muted)',
    fontSize: '0.76rem',
    fontWeight: 800,
    padding: '6px 10px'
  };
}
