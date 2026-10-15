const values = value => [...new Set(String(value || '').split(/[;,]/).map(item => item.trim()).filter(Boolean))];

export function feishuSourceChoices(source) {
  return source.chat_type === 'direct' ? ['direct'] : ['user', 'chat'];
}

export function feishuUsersEmpty(form) {
  return values(form.allowed_user_ids).length === 0;
}

export function feishuSourceIncluded(form, source, choice) {
  if (!feishuSourceChoices(source).includes(choice)) return false;
  const chatIncluded = values(form.allowed_chat_ids).includes(source.chat_id);
  const userIncluded = values(form.allowed_user_ids).includes(source.user_id);
  return choice === 'direct' ? chatIncluded && userIncluded : choice === 'user' ? userIncluded : chatIncluded;
}

export function appendFeishuSource(form, source, choice) {
  if (!feishuSourceChoices(source).includes(choice)) return form;
  const next = { ...form };
  if (choice === 'direct' || choice === 'chat') {
    next.allowed_chat_ids = [...new Set([...values(form.allowed_chat_ids), source.chat_id].filter(Boolean))].join(', ');
  }
  if (choice === 'direct' || choice === 'user') {
    next.allowed_user_ids = [...new Set([...values(form.allowed_user_ids), source.user_id].filter(Boolean))].join(', ');
  }
  return next;
}
