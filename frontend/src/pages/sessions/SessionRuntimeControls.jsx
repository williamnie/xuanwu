import { availableProviderModels, availableProviderModelValue, modelLabel, SERVICE_TIER_STANDARD } from './sessionOptions';
import { modelDisplayLabel, modelHint, modelPlaceholder, compactModelName, effortDisplayLabel, effortOptionKey, serviceTierDisplayLabel, serviceTierOptionKey } from './sessionComposerLabels.js';
import { settingsExecutionPolicy, executionPolicyValue, executionPolicyPresets, applyExecutionPolicy, policyFromValue } from '../../utils/executionPolicy.js';
import { Cpu, Brain, Gauge, ShieldAlert, ChevronDown } from 'lucide-react';

export function RuntimeControls({ settings, onSettingChange, models, modelsLoading, modelsError, effortOptions, tierOptions, effectiveModel, providerCatalog }) {
  const modelOptions = availableProviderModels(models);
  const selectedModel = availableProviderModelValue(settings.model, modelOptions);
  return (
    <>
      <PermissionSelect settings={settings} onSettingChange={onSettingChange} providerCatalog={providerCatalog} />
      <CompactSelect
        className="model"
        icon={<Cpu size={14} />}
        value={selectedModel}
        displayLabel={modelDisplayLabel(selectedModel, effectiveModel, modelOptions)}
        onChange={(value) => onSettingChange('model', value)}
        title={modelHint(modelsLoading, modelsError)}
      >
        <option value="">{modelPlaceholder(modelsLoading, modelsError, effectiveModel)}</option>
        {modelOptions.map((model) => <option key={model.id || model.model} value={model.id || model.model}>{compactModelName(modelLabel(model))}</option>)}
      </CompactSelect>
      <CompactSelect
        className="effort"
        icon={<Brain size={14} />}
        value={settings.reasoningEffort}
        displayLabel={effortDisplayLabel(effortOptions, settings.reasoningEffort)}
        onChange={(value) => onSettingChange('reasoningEffort', value)}
        title="推理强度"
      >
        {effortOptions.map((option) => (
          <option key={effortOptionKey(option)} value={option.value}>{option.shortLabel || option.label}</option>
        ))}
      </CompactSelect>
      {settings.provider !== 'qoder' ? <CompactSelect
        className="speed"
        icon={<Gauge size={14} />}
        value={settings.serviceTier || SERVICE_TIER_STANDARD}
        displayLabel={serviceTierDisplayLabel(tierOptions, settings.serviceTier)}
        onChange={(value) => onSettingChange('serviceTier', value)}
        title="速度"
      >
        {tierOptions.map((option) => (
          <option key={serviceTierOptionKey(option)} value={option.value}>{option.shortLabel || option.label}</option>
        ))}
      </CompactSelect> : null}
    </>
  );
}

export function PermissionSelect({ settings, onSettingChange, providerCatalog }) {
  const policy = settingsExecutionPolicy(settings);
  const value = executionPolicyValue(policy);
  const presets = executionPolicyPresets(providerCatalog, settings.provider, policy);
  const preset = presets.find((item) => item.value === value) || presets[0];
  return (
    <CompactSelect
      className={`permission ${preset.tone}`}
      icon={<ShieldAlert size={14} />}
      value={preset.value}
      displayLabel={preset.label}
      onChange={(nextValue) => {
        const next = applyExecutionPolicy(settings, policyFromValue(nextValue));
        onSettingChange('executionPolicy', next.executionPolicy);
        onSettingChange('sandbox', next.sandbox);
        onSettingChange('approvalPolicy', next.approvalPolicy);
      }}
      title="权限与授权策略"
    >
      {presets.map((option) => (
        <option
          disabled={option.disabled}
          key={option.value}
          value={option.value}
        >
          {option.label}{option.disabled ? '（当前 transport 不支持）' : ''}
        </option>
      ))}
    </CompactSelect>
  );
}

export function CompactSelect({ className, icon, value, displayLabel, onChange, title, children }) {
  return (
    <label className={`session-composer-select ${className}`} title={title}>
      {icon}
      <span className="session-composer-select-value">{displayLabel}</span>
      <select aria-label={title} value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
      <ChevronDown size={13} className="session-composer-chevron" />
    </label>
  );
}
