// App owns one promise for the page lifetime, including effect replay and a
// return from task detail. Refreshing status must not repeat this audited test.
export function createFirstDeliveryConnectionCheck(api) {
  let pending;
  const check = () => {
    pending ||= checkSavedConnection(api).catch(() => ({ ok: false, message: '无法检查玄武助手连接，请在下方手动测试。' }));
    return pending;
  };
  check.remember = result => { pending = Promise.resolve(result); };
  return check;
}

async function checkSavedConnection(api) {
  const [supervisor, settings] = await Promise.all([api.getPiSupervisor(), api.getPiProviderSettings()]);
  if (!supervisor?.enabled || !supervisor.model_provider || !supervisor.model_id) return null;
  const provider = settings?.providers?.find(item => item.id === supervisor.model_provider);
  const oauth = supervisor.model_provider === 'openai-codex' || provider?.api === 'openai-codex-responses';
  if (oauth) {
    const status = await api.getPiCodexOAuthStatus();
    if (!status?.pi_oauth?.configured) return null;
  } else if (!provider?.base_url || !provider.api_key_configured) return null;
  return api.testPiProviderConnection(supervisor.model_provider, {
    api: oauth ? 'openai-codex-responses' : provider.api,
    base_url: provider?.base_url || '',
    models: supervisor.model_id,
    user_agent: provider?.user_agent || '',
  });
}

export function projectPathFeedback(result) {
  if (!result?.exists) return '路径不存在，请检查后重试。';
  if (!result.directory) return '此路径是文件，请选择项目文件夹。';
  if (!result.git_repo) return '文件夹里没有找到 Git 仓库，请选择含 .git 的项目根目录。';
  return result.existing_project_id ? '这个文件夹已添加，可直接使用已有项目。' : '路径检查通过，可以添加此项目。';
}

export function codexImportFailure(error) {
  const reason = String(error?.message || '');
  if (/ENOENT|not found|no such file/i.test(reason)) return '未找到本机 Codex Desktop 工作区。请先在 Codex Desktop 打开项目，或直接输入文件夹路径。';
  if (/EACCES|EPERM|permission/i.test(reason)) return '无法读取本机 Codex Desktop 工作区，请检查访问权限，或直接输入文件夹路径。';
  if (/JSON|parse|unexpected token/i.test(reason)) return '本机 Codex Desktop 工作区记录无法读取，请重新打开 Codex Desktop 后重试，或直接输入路径。';
  return '暂时无法导入 Codex Desktop 工作区，请稍后重试，或直接输入项目文件夹路径。';
}
