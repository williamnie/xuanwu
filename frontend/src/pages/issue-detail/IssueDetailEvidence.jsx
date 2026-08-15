import { AlertTriangle, Settings2 } from 'lucide-react';
import IssueSupervisorPanel from '../IssueSupervisorPanel';
import { serviceTierLabel, serviceTierOptions } from '../../utils/serviceTier';
import { hasMcpRequirements, mcpRequirementStatus } from '../../utils/mcpRequirements';
import { formatDateTime, issuePriorityLabel } from './issueDetailFormatters';
import './IssueDetailEvidence.css';

export default function IssueDetailEvidence({
  issue,
  profileSummary,
  runtimeIdentity,
  runtimeProvider,
  mcpSummary,
  supervisor,
  hasSupervisorHistory,
  hasCurrentSupervisorSignal,
  onServiceTierChange,
  onIssueLogModeChange,
  actionControls,
  verificationEvidence,
}) {
  return (
    <>
      <IssueMetadataPanel
        issue={issue}
        profileSummary={profileSummary}
        runtimeIdentity={runtimeIdentity}
        runtimeProvider={runtimeProvider}
        onServiceTierChange={onServiceTierChange}
        onIssueLogModeChange={onIssueLogModeChange}
      />

      {actionControls}

      {hasMcpRequirements(mcpSummary) && <IssueMcpRequirementsPanel summary={mcpSummary} />}

      {hasSupervisorHistory && !hasCurrentSupervisorSignal && (
        <IssueSupervisorPanel supervisor={supervisor} />
      )}

      {verificationEvidence}
    </>
  );
}

export function CurrentSupervisorEvidence({ supervisor, visible }) {
  return visible ? <IssueSupervisorPanel supervisor={supervisor} /> : null;
}

function IssueMetadataPanel({
  issue,
  profileSummary,
  runtimeIdentity,
  runtimeProvider,
  onServiceTierChange,
  onIssueLogModeChange,
}) {
  return (
    <section className="issue-advanced-card">
      <div className="issue-section-heading">
        <div>
          <span className="issue-section-eyebrow">Runtime metadata</span>
          <h2><Settings2 size={17} /> 运行元数据</h2>
        </div>
      </div>
      <div className="issue-metadata-list">
        <MetadataRow label="当前状态" value={String(issue.status || 'unknown').toUpperCase()} />
        <MetadataRow label="尝试次数" value={`${issue.attempt_count || 0} 次`} />
        <MetadataRow label="优先级" value={issuePriorityLabel(issue.priority)} />
        <MetadataRow label="Provider" value={runtimeProvider} />
        <MetadataRow label="Agent Profile" value={profileSummary} />
        <MetadataRow label="Session ID" value={runtimeIdentity.sessionId || '未分配'} mono />
        <MetadataRow label="Turn ID" value={runtimeIdentity.turnId || '暂无'} mono />
        <MetadataRow label="创建时间" value={formatDateTime(issue.created_at)} />
        <MetadataRow label="最后更新" value={formatDateTime(issue.updated_at)} />
      </div>
      <label className="issue-service-tier-field">
        <span>下次运行速度</span>
        <select
          className="form-control"
          value={issue.service_tier || ''}
          onChange={(event) => onServiceTierChange(event.target.value)}
          disabled={issue.status === 'in_progress'}
        >
          {serviceTierOptions(issue.service_tier).map(option => (
            <option key={option.value || 'standard'} value={option.value}>{option.label}</option>
          ))}
        </select>
        <small>当前：{serviceTierLabel(issue.service_tier)}。运行中修改不会影响本轮快照。</small>
      </label>
      <label className="issue-service-tier-field">
        <span>日志模式</span>
        <select
          className="form-control"
          value={issue.issue_log_mode || 'normal'}
          onChange={(event) => onIssueLogModeChange(event.target.value)}
          disabled={issue.status === 'in_progress'}
        >
          <option value="normal">Normal · 仅关键事件</option>
          <option value="debug">Debug · 详细 provider 日志</option>
        </select>
        <small>Debug 只影响下次运行；默认 Normal，避免原始流式日志持续写入 SQLite。</small>
      </label>
    </section>
  );
}

function MetadataRow({ label, value, mono = false }) {
  return (
    <div>
      <span>{label}</span>
      <strong className={mono ? 'mono' : ''}>{value}</strong>
    </div>
  );
}

function IssueMcpRequirementsPanel({ summary }) {
  const active = hasMcpRequirements(summary);
  return (
    <section className="glass-card issue-mcp-requirements">
      <div className="issue-mcp-requirements__header">
        <h3 className="issue-mcp-requirements__heading">MCP requirements</h3>
        <span className={`triage-readiness-badge ${summary.diagnostics.length ? 'refined' : active ? 'ready' : 'raw'}`}>
          {mcpRequirementStatus(summary)}
        </span>
      </div>
      <p className="issue-mcp-requirements__description">
        这里只显示 issue/project/delegation 的 MCP capability 需求；不会直接执行 MCP。
      </p>
      <McpCapabilityGroup label="Required" items={summary.required} />
      <McpCapabilityGroup label="Recommended" items={summary.recommended} />
      <McpCapabilityGroup label="Project allowlist" items={summary.projectAllowed} />
      {summary.diagnostics.length > 0 && (
        <div className="issue-mcp-requirements__diagnostics">
          {summary.diagnostics.map((item, index) => (
            <span key={`${item.scope}-${item.capability_id}-${index}`}>
              <AlertTriangle size={13} /> {item.scope}: {item.capability_id} 未注册
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function McpCapabilityGroup({ label, items }) {
  return (
    <div className="issue-mcp-requirements__group">
      <span className="issue-mcp-requirements__label">{label}</span>
      {items.length > 0 ? (
        <div className="issue-mcp-requirements__capabilities">
          {items.map(item => <code className="issue-mcp-requirements__capability" key={item}>{item}</code>)}
        </div>
      ) : (
        <span className="issue-mcp-requirements__empty">未声明</span>
      )}
    </div>
  );
}
