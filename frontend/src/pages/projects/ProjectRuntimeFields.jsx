import { useI18n } from '../../i18n/context.js';
import { serviceTierOptions } from '../../utils/serviceTier.js';
import { codeAgentLabel } from '../../utils/codeAgents.js';
import { executionPolicyPresets, executionPolicyValue, isolationLabel, policyFromValue } from '../../utils/executionPolicy.js';

export default function ProjectRuntimeFields({ modelOptions, onFieldChange, providerOptions, ui }) {
  const { language } = useI18n();
  const english = language === 'en-US';
  const providerReady = providerOptions.some(option => option.value === ui.formProvider);
  const providerSelectDisabled = ui.providerCatalogLoading || Boolean(ui.providerCatalogError) || providerOptions.length === 0;
  const policyOptions = executionPolicyPresets(ui.providerCatalog, ui.formProvider, ui.formExecutionPolicy);
  const policyValue = executionPolicyValue(ui.formExecutionPolicy);

  return (
    <div className="project-runtime-fields">
      <div className="form-group">
        <label><span className="ds-mono-label">{english ? 'Coding tool' : '编程工具'}</span></label>
        <select
          aria-busy={ui.providerCatalogLoading}
          className={`form-control${ui.providerCatalogLoading ? ' project-settings-control-loading' : ''}`}
          disabled={providerSelectDisabled}
          onChange={event => onFieldChange('formProvider', event.target.value)}
          value={ui.formProvider}
        >
          {ui.providerCatalogLoading && <option value="">正在读取可用编程工具…</option>}
          {!ui.providerCatalogLoading && ui.providerCatalogError && <option value="">编程工具加载失败</option>}
          {!ui.providerCatalogLoading && !ui.providerCatalogError && providerOptions.length === 0 && <option value="">暂无可用编程工具</option>}
          {!ui.providerCatalogLoading && !ui.providerCatalogError && ui.formProvider && !providerReady && (
            <option disabled value={ui.formProvider}>{codeAgentLabel(ui.formProvider, ui.providerCatalog)}（不可用）</option>
          )}
          {providerOptions.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <span
          aria-live="polite"
          className={`project-settings-hint${ui.providerCatalogLoading ? ' project-settings-loading-hint' : ''}${ui.providerCatalogError || (!ui.providerCatalogLoading && !providerReady) ? ' project-settings-hint-error' : ''}`}
          role="status"
        >
          {ui.providerCatalogLoading
            ? '正在读取已启用且可用的 Code Agent…'
            : ui.providerCatalogError
              ? `读取编程工具失败：${ui.providerCatalogError}`
              : !providerReady
                ? '项目原编程工具当前不可用，请从可用列表中重新选择。'
                : '决定由哪个执行器处理项目；通常保持 Codex。'}
        </span>
      </div>

      <div className="form-group">
        <label><span className="ds-mono-label">{english ? 'Default model' : '默认模型'}</span></label>
        <select aria-label={english ? 'Default model' : '默认模型'} className="form-control" disabled={ui.codexModelsLoading} onChange={event => onFieldChange('formModel', event.target.value)} value={ui.formModel}>
          {modelOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <span className="project-settings-hint">
          {ui.codexModelsLoading
            ? (english ? 'Loading coding tool models…' : '正在读取编程工具模型列表…')
            : ui.codexModelsError
              ? (english ? `Model list unavailable; current value preserved: ${ui.codexModelsError}` : `模型列表读取失败，已保留当前值：${ui.codexModelsError}`)
              : ui.formProvider === 'qoder' && ui.codexModels.some(model => model?.verified === false)
                ? (english ? 'Model discovery unavailable; suggestions are unverified and the current value is preserved.' : 'Qoder 账号发现不可用；候选仅是静态建议，已保留当前自定义值。')
                : (english ? 'Models come from the selected coding tool.' : '模型列表来自当前编程工具。')}
        </span>
      </div>
      {ui.formProvider !== 'qoder' ? (
        <details className="project-settings-advanced">
          <summary>{english ? 'More options' : '更多选项'}</summary>
          <div className="project-runtime-fields">
            <div className="form-group">
              <label><span className="ds-mono-label">{english ? 'Execution speed' : '执行速度'}</span></label>
              <select className="form-control" onChange={event => onFieldChange('formServiceTier', event.target.value)} value={ui.formServiceTier}>
                {serviceTierOptions(ui.formServiceTier).map(option => <option key={option.value || 'standard'} value={option.value}>{english ? ({ '': 'Standard', priority: 'Fast' }[option.value] || option.label) : option.label}</option>)}
              </select>
              <span className="project-settings-hint">{english ? 'Standard speed suits most projects.' : '标准速度适合大多数项目。'}</span>
            </div>
          </div>
        </details>
      ) : null}

      <div className="form-group">
        <label><span className="ds-mono-label">执行权限与确认</span></label>
        <select className="form-control" onChange={event => onFieldChange('formExecutionPolicy', policyFromValue(event.target.value))} value={policyValue}>
          {policyOptions.map(option => (
            <option disabled={option.disabled} key={option.id} value={option.value} title={option.reason}>{option.label}{option.disabled ? '（当前 transport 不支持）' : ''}</option>
          ))}
        </select>
        <span className="project-settings-hint">隔离能力：{isolationLabel(ui.providerCatalog, ui.formProvider)}。低权限仍会启动；越权操作会被拒绝，需要确认的操作会暂停并通知你。</span>
        {ui.formExecutionPolicy.access !== 'unrestricted-host' || ui.formExecutionPolicy.approval !== 'unattended' ? (
          <div className="project-settings-permission-notice" role="status">任务可能等待审批或因当前权限不足而无法完成，但不会仅因选择低权限而拒绝启动。</div>
        ) : null}
      </div>
    </div>
  );
}
