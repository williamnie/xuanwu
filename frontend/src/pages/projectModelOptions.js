const DEFAULT_PROVIDER = 'codex';
const DEFAULT_CODEX_MODEL = 'codex-default';

export function normalizeProviderModel(provider, model) {
  const value = String(model || '').trim();
  return value || (provider === DEFAULT_PROVIDER ? DEFAULT_CODEX_MODEL : '');
}

export function buildProviderModelOptions(provider, models, selectedValues = [], language = 'zh-CN') {
  const english = language === 'en-US';
  const options = [];
  const seen = new Set();
  const pushOption = (value, label) => {
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue || seen.has(normalizedValue)) return;
    seen.add(normalizedValue);
    options.push({ value: normalizedValue, label: String(label || normalizedValue).trim() || normalizedValue });
  };

  if (provider === DEFAULT_PROVIDER) {
    pushOption(DEFAULT_CODEX_MODEL, english ? 'System default model' : '系统默认模型');
  } else {
    seen.add('');
    options.push({ value: '', label: english ? 'Coding tool default' : '编程工具默认模型' });
  }
  const liveModels = Array.isArray(models) ? models.filter(model => !model?.hidden) : [];
  liveModels.forEach(model => pushOption(model?.id || model?.model, model?.displayName || model?.name || model?.id || model?.model));
  selectedValues.forEach(value => {
    const normalizedValue = normalizeProviderModel(provider, value);
    pushOption(normalizedValue, `${normalizedValue} · ${english ? 'Current value (custom)' : '当前值（自定义）'}`);
  });
  return options;
}

