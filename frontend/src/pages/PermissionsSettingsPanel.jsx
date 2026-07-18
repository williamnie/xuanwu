import { connectorsApi } from '../api/connectors.js';
import { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, ShieldCheck } from 'lucide-react';
import { PanelLoader } from '../components/TurtleLoader';
import { connectorPermissionRows } from './settingsProductModels.js';

const RISK_MATRIX = [
  { family: '可信只读', gate: '直接执行', risk: 'read_only', scope: '无需 grant' },
  { family: 'Issue / Work / Run / Evidence / Handoff 内部写', gate: '需要确认', risk: 'internal_write', scope: '当前仅批准一次' },
  { family: 'Provider 命令或文件操作', gate: '需要确认', risk: 'internal_write', scope: '当前仅批准一次' },
  { family: 'Git push / PR / deploy / 外部写', gate: '需要确认', risk: 'external_write', scope: '仅批准一次' },
  { family: '破坏性命令 / force push / 提权或 secret 访问', gate: '确定性拒绝', risk: 'dangerous', scope: '不得由 LLM 放行' },
];

export default function PermissionsSettingsPanel({ navigateTo }) {
  const [state, setState] = useState({ connectors: [], error: '', loading: true });
  const load = () => loadPermissions(setState);
  useEffect(() => { load(); }, []);
  const rows = connectorPermissionRows(state.connectors);
  return (
    <section className="glass-card settings-permissions-panel">
      <PanelHeader loading={state.loading} onRefresh={load} />
      {state.error && <div className="settings-inline-error" role="alert">{state.error}</div>}
      {!state.error && state.loading && rows.length === 0 && <PanelLoader label="正在读取 Connector 权限…" />}
      {!state.error && (!state.loading || rows.length > 0) && <ConnectorPermissionMatrix rows={rows} />}
      <ApprovalRiskMatrix />
      <AuditBoundary navigateTo={navigateTo} />
    </section>
  );
}

function PanelHeader({ loading, onRefresh }) {
  return (
    <div className="settings-product-header">
      <div>
        <h2><ShieldCheck size={18} color="var(--primary)" /> 权限矩阵</h2>
        <p>Connector capability 来自实时 connector API；风险裁决继续由现有 Approval 与 Action Gate authority 执行。</p>
      </div>
      <button className="btn btn-secondary" disabled={loading} onClick={onRefresh} type="button">
        <RefreshCw size={15} className={loading ? 'spin-animation' : ''} />刷新
      </button>
    </div>
  );
}

function ConnectorPermissionMatrix({ rows }) {
  return (
    <div className="settings-matrix-block">
      <div className="settings-block-title">连接能力</div>
      {rows.length === 0 ? <div className="settings-empty-state">当前 connector 未声明 capability。</div> : (
        <div className="settings-permission-table" role="table" aria-label="Connector permission matrix">
          <MatrixHeader labels={['连接', 'Capability', '方向', '授权']} />
          {rows.map(row => (
            <div className="settings-permission-row" role="row" key={`${row.connectorID}:${row.capabilityID}`}>
              <span>{row.connectorLabel}</span>
              <code>{row.capabilityID}</code>
              <span>{row.direction}</span>
              <strong className={row.authorization === 'required' ? 'is-warning' : ''}>{row.authorization}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ApprovalRiskMatrix() {
  return (
    <div className="settings-matrix-block">
      <div className="settings-block-title">Action Gate 风险边界</div>
      <div className="settings-risk-copy"><AlertTriangle size={15} /> LLM 只能提出 action；不能降低风险、扩大 scope 或绕过确定性 deny。</div>
      <div className="settings-permission-table settings-risk-table" role="table" aria-label="Approval risk matrix">
        <MatrixHeader labels={['操作族', '风险', 'Gate', '当前范围']} />
        {RISK_MATRIX.map(row => (
          <div className="settings-permission-row" role="row" key={row.family}>
            <span>{row.family}</span>
            <code>{row.risk}</code>
            <strong className={row.gate === '确定性拒绝' ? 'is-danger' : row.gate === '需要确认' ? 'is-warning' : ''}>{row.gate}</strong>
            <span>{row.scope}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MatrixHeader({ labels }) {
  return <div className="settings-permission-row settings-permission-header" role="row">{labels.map(label => <span key={label}>{label}</span>)}</div>;
}

function AuditBoundary({ navigateTo }) {
  return (
    <div className="settings-authority-note">
      <div>
        <strong>权限变更与决策审计</strong>
        <p><code>pi_approval_requests</code> 记录 provider approval；<code>pi_actions</code> 与 <code>pi_action_events</code> 记录 gate、人工决定和执行结果；项目 policy 仍是项目级权限上限。</p>
      </div>
      <div className="settings-authority-actions">
        <button className="btn btn-secondary" onClick={() => navigateTo?.('command-center')} type="button">查看待处理审批</button>
        <button className="btn btn-secondary" onClick={() => navigateTo?.('pi-activity')} type="button">查看审计活动</button>
      </div>
    </div>
  );
}

function loadPermissions(setState) {
  setState(previous => ({ ...previous, loading: true }));
  connectorsApi.getPiConnectors()
    .then(data => setState({ connectors: data?.connectors || [], error: '', loading: false }))
    .catch(error => setState(previous => ({ ...previous, error: error.message || '读取权限矩阵失败', loading: false })));
}
