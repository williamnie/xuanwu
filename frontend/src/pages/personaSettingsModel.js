// 表达风格单独保存（方案 6.4 ④）：只提交 persona 字段并带 expected_revision，
// 后端对空的助手字段补丁不做修改，因此不会覆盖“AI 连接 → 玄武助手”里的名称、思考强度和长期说明。
export function personaFormFromSupervisor(supervisor) {
  const persona = supervisor?.persona || {};
  return {
    communicationStyle: persona.communication_style || '',
    enabled: persona.enabled === 1,
    languageMode: persona.language_mode || 'system',
    personality: persona.personality || '',
    revision: Number.isInteger(persona.revision) ? persona.revision : 0,
    verbosity: persona.verbosity || 'adaptive',
  };
}

export function personaPatchPayload(form) {
  return {
    persona: {
      communication_style: form.communicationStyle,
      enabled: form.enabled,
      expected_revision: form.revision,
      language_mode: form.languageMode,
      personality: form.personality,
      verbosity: form.verbosity,
    },
  };
}

export function personaDirty(form, saved) {
  return ['communicationStyle', 'enabled', 'languageMode', 'personality', 'verbosity'].some(key => form?.[key] !== saved?.[key]);
}
