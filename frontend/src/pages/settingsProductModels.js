export function buildNotificationPreferencePayload(form) {
  return {
    digest_policy: form.digestPolicy || {},
    mode: form.mode,
    notify_on: form.notifyOn,
    policy_kind: 'user_preference',
    scope: 'global',
    source_message_id: 'settings:notifications',
  };
}

export function connectorPermissionRows(connectors) {
  return (Array.isArray(connectors) ? connectors : []).flatMap(connector => (
    Array.isArray(connector.permissions) ? connector.permissions.map(permission => ({
      authorization: permission.authorization || 'unknown',
      capabilityID: permission.capability_id || 'unknown',
      connectorID: connector.id || 'connector',
      connectorLabel: connector.label || connector.id || 'Connector',
      direction: permission.direction || 'unknown',
    })) : []
  ));
}

export function configureGuide(connector) {
  const id = String(connector?.id || '');
  const refs = (connector?.secret_refs || []).map(item => item.ref).filter(Boolean).join(' · ');
  if (id === 'feishu') return { title: '飞书连接配置', body: '使用本页下方现有飞书表单保存 App、接收模式与 allowlist；secret 明文不会从 API 读回。', refs };
  if (id === 'webhook') return { title: 'Webhook 签名配置', body: '通过当前 runtime 声明的 signing secret ref 配置；重载服务后再运行只读测试。', refs };
  if (id.endsWith('-events')) return { title: 'Git provider 配置', body: 'Git 事件连接复用现有 GitHub/GitLab provider credential 与 repository mapping，不在 Integrations 创建第二份 token。', refs };
  if (id.endsWith('-issues')) return { title: 'Tracker provider 配置', body: 'Tracker 复用对应 provider credential、mapping 与 Issue authority；Linear 未配置时保持 disabled。', refs };
  return { title: 'Connector manifest 配置', body: '按当前 manifest/env 声明补齐缺失项，然后刷新 health；Integrations 不读取 secret material。', refs };
}
