import { supportedEffortValues, REASONING_EFFORT_OPTIONS, modelLabel, SERVICE_TIER_STANDARD } from './sessionOptions';

export function visibleEffortOptions(model, selectedValue, provider) {
  const supported = supportedEffortValues(model);
  const inherited = { value: '', label: '默认推理强度', shortLabel: effortShortLabel(model?.defaultReasoningEffort) || '默认' };
  if (provider === 'qoder') {
    if (model?.verified !== true || !supported.length) {
      return selectedValue
        ? [inherited, { value: selectedValue, label: `${selectedValue}（未验证）`, shortLabel: selectedValue }]
        : [inherited];
    }
    const qoderOptions = supported.map((value) => {
      const known = REASONING_EFFORT_OPTIONS.find((option) => option.value === value);
      return known || { value, label: value, shortLabel: value };
    });
    if (selectedValue && !supported.includes(selectedValue)) {
      qoderOptions.push({ value: selectedValue, label: `${selectedValue}（当前模型不支持）`, shortLabel: selectedValue });
    }
    return [inherited, ...qoderOptions];
  }
  if (!supported.length) return [inherited, ...REASONING_EFFORT_OPTIONS.filter((option) => option.value)];
  return [inherited, ...REASONING_EFFORT_OPTIONS.filter((option) => supported.includes(option.value) || option.value === selectedValue)];
}

export function modelHint(loading, error) {
  if (loading) return '正在读取编程工具模型列表';
  if (error) return `模型列表暂未加载：${error}`;
  return '模型';
}

export function modelPlaceholder(loading, _error, model) {
  if (loading) return '读取模型';
  if (!model) return '编程工具默认';
  return compactModelName(modelLabel(model)) || '编程工具默认';
}

export function modelDisplayLabel(value, effectiveModel, models) {
  const selected = models.find((model) => model.id === value || model.model === value);
  if (selected) return compactModelName(modelLabel(selected));
  if (value) return compactModelName(value);
  return modelPlaceholder(false, '', effectiveModel);
}

export function effortOptionKey(option) {
  return `${option.value || 'inherit'}:${option.label || ''}:${option.shortLabel || ''}`;
}

export function effortDisplayLabel(options, value) {
  const option = options.find((item) => item.value === value);
  return option?.shortLabel || option?.label || '默认';
}

export function serviceTierOptionKey(option) {
  return `${option.value || 'standard'}:${option.label || ''}`;
}

export function serviceTierDisplayLabel(options, value) {
  const option = options.find((item) => item.value === (value || SERVICE_TIER_STANDARD));
  return option?.shortLabel || option?.label || '标准';
}

export function compactModelName(value) {
  return String(value || '')
    .replace(/^gpt[-\s]*/i, '')
    .replace(/^GPT[-\s]*/i, '')
    .replace(/-/g, ' ')
    .trim();
}

export function effortShortLabel(value) {
  return REASONING_EFFORT_OPTIONS.find((option) => option.value === value)?.shortLabel || '';
}
