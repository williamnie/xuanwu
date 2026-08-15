import { automationApi } from '../api/automation.js';
import { useEffect, useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import './SourcePoliciesPanel.css';

export default function SourcePoliciesPanel() {
  const [state, setState] = useState({ data: null, error: '', loading: true });
  useEffect(() => { loadPolicies(setState); }, []);
  return (
    <section className="glass-card source-policies">
      <PanelHeader loading={state.loading} onRefresh={() => loadPolicies(setState)} />
      {state.error && <div className="source-policies__error">{state.error}</div>}
      <PolicyLayers layers={state.data?.layers || []} />
      <div className="source-policies__profiles">
        <strong className="source-policies__profiles-title">Read-only source profiles</strong>
        <div className="source-policies__pills">
          {(state.data?.profiles || []).map((profile) => (
            <span className="source-policies__pill" key={profile.id}>{profile.id} · {profile.policy?.action_mode}</span>
          ))}
        </div>
        <small className="source-policies__note">
          W2 起 Automation 的权限由 permission_policy_ref 管理；旧 pi_automations policy-only 写入已退役。
        </small>
      </div>
    </section>
  );
}

function PanelHeader({ loading, onRefresh }) {
  return (
    <div className="source-policies__header">
      <div>
        <h2 className="source-policies__heading">
          <ShieldCheck size={18} color="var(--primary)" /> Source Policy
        </h2>
        <p className="source-policies__description">
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
    <div className="source-policies__pills">
      {layers.map((layer, index) => <span className="source-policies__pill" key={layer.scope}>{index + 1}. {layer.scope}</span>)}
    </div>
  );
}

function loadPolicies(setState) {
  setState((previous) => ({ ...previous, loading: true }));
  automationApi.getPiSourcePolicies()
    .then((data) => setState({ data, error: '', loading: false }))
    .catch((error) => setState((previous) => ({ ...previous, error: error.message || '读取 source policies 失败', loading: false })));
}
