import { connectorsApi } from '../api/connectors.js';
import { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, ShieldCheck } from 'lucide-react';
import { PanelLoader } from '../components/TurtleLoader';
import { connectorPermissionRows } from './settingsProductModels.js';

const RISK_MATRIX = [
  { family: '可信只读操作', gate: '直接执行', risk: 'read_only', scope: '无需授权' },
  { family: '修改工作项、运行、证据或交付记录', gate: '需要确认', risk: 'internal_write', scope: '当前仅批准一次' },
  { family: '编程工具执行命令或操作文件', gate: '需要确认', risk: 'internal_write', scope: '当前仅批准一次' },
  { family: 'Git push、创建 PR、部署或其他外部修改', gate: '需要确认', risk: 'external_write', scope: '仅批准一次' },
  { family: '破坏性命令、force push、提权或密钥访问', gate: '确定性拒绝', risk: 'dangerous', scope: 'AI 无法自行放行' },
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
      {!state.error && state.loading && rows.length === 0 && <PanelLoader label="正在读取外部连接权限…" />}
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
        <h2><ShieldCheck size={18} color="var(--primary)" /> 执行权限</h2>
        <p>查看各连接能执行的操作，以及哪些操作需要你确认。实际执行仍受项目规则和审批限制。</p>
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
      {rows.length === 0 ? <div className="settings-empty-state">当前没有可显示的连接能力。可前往外部连接检查配置。</div> : (
        <div className="settings-permission-table" role="table" aria-label="外部连接权限">
          <MatrixHeader labels={['连接', '能力标识', '方向', '授权']} />
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
      <div className="settings-block-title">操作与审批规则</div>
      <div className="settings-risk-copy"><AlertTriangle size={15} /> AI 只能提出操作建议，不能自行降低风险等级、扩大授权范围或绕过明确禁止的操作。</div>
      <div className="settings-permission-table settings-risk-table" role="table" aria-label="操作审批规则">
        <MatrixHeader labels={['操作类型', '风险标识', '执行要求', '授权范围']} />
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
        <strong>查看审批与操作记录</strong>
        <p>需要你确认的操作会显示在工作台。审批决定和执行结果都会保留记录，批准后也不能超出项目允许的权限范围。</p>
      </div>
      <div className="settings-authority-actions">
        <button className="btn btn-secondary" onClick={() => navigateTo?.('command-center')} type="button">查看待处理审批</button>
        <button className="btn btn-secondary" onClick={() => navigateTo?.('pi-activity')} type="button">查看活动记录</button>
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
