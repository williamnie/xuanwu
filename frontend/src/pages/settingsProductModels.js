// 通知方式主选项只有“及时 / 汇总 / 安静”；“详细”显示为“及时”下的开关，提交时仍写原来的 normal / verbose。
// 未知的旧值原样保留，直到用户主动改选。
const NOTIFICATION_CHOICES = { digest: 'digest', normal: 'timely', quiet: 'quiet', verbose: 'timely' };

export function notificationModeChoice(mode) {
  return NOTIFICATION_CHOICES[mode] || 'legacy';
}

export function notificationModeValue(choice, { currentMode = 'normal', includeProgress = false } = {}) {
  if (choice === 'timely') return includeProgress ? 'verbose' : 'normal';
  if (choice === 'digest' || choice === 'quiet') return choice;
  return currentMode;
}

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

export function configureGuide(connector, language = 'zh-CN') {
  const id = String(connector?.id || '');
  const refs = (connector?.secret_refs || []).map(item => item.ref).filter(Boolean).join(' · ');
  const english = language === 'en-US';
  if (id === 'feishu') return {
    title: english ? 'Feishu connection settings' : '飞书连接配置',
    body: english ? 'Open the Feishu settings drawer under External connections to configure credentials, event subscriptions and notification targets. Saved secrets are never read back.' : '在外部连接中打开飞书设置抽屉，配置应用凭据、事件订阅与通知目标；已保存的密钥不会从 API 读回。', refs,
  };
  if (id === 'telegram') return {
    title: english ? 'Telegram connection settings' : 'Telegram 连接配置',
    body: english ? 'Open the Telegram settings drawer under External connections to configure the bot, allowed sources and project mappings. Saved secrets are never read back.' : '在外部连接中打开 Telegram 设置抽屉，配置 Bot、安全来源与项目映射；已保存的密钥不会从 API 读回。', refs,
  };
  if (id === 'webhook') return { title: 'Webhook 签名配置', body: '通过当前 runtime 声明的 signing secret ref 配置；重载服务后再运行只读测试。', refs };
  if (id.endsWith('-events')) return { title: 'Git provider 配置', body: 'Git 事件连接复用现有 GitHub/GitLab provider credential 与 repository mapping，不在 Integrations 创建第二份 token。', refs };
  if (id.endsWith('-issues')) return { title: 'Tracker provider 配置', body: 'Tracker 复用对应 provider credential、mapping 与 Issue authority；Linear 未配置时保持 disabled。', refs };
  return { title: 'Connector manifest 配置', body: '按当前 manifest/env 声明补齐缺失项，然后刷新 health；Integrations 不读取 secret material。', refs };
}
