const values = value => [...new Set(String(value || '').split(/[;,]/).map(item => item.trim()).filter(Boolean))];

export function feishuSourceIncluded(form, source) {
  return values(form.allowed_chat_ids).includes(source.chat_id) && values(form.allowed_user_ids).includes(source.user_id);
}

export function appendFeishuSource(form, source) {
  return {
    ...form,
    allowed_chat_ids: [...new Set([...values(form.allowed_chat_ids), source.chat_id].filter(Boolean))].join(', '),
    allowed_user_ids: [...new Set([...values(form.allowed_user_ids), source.user_id].filter(Boolean))].join(', '),
  };
}
