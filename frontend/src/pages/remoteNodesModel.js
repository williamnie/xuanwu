// 远程节点（Agent 端）的展示模型：状态、启动命令、内网判断。

/** 中心地址是否属于内网：localhost、RFC1918、Tailscale CGNAT(100.64/10)、*.local / *.ts.net、IPv6 本地地址。 */
export function isPrivateHubHost(hostname = '') {
  const host = String(hostname).trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '' || host === 'localhost' || host.endsWith('.local') || host.endsWith('.ts.net')) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(':')) return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
  return false;
}

/** 节点在线状态与提醒：offline / online，非内网连接额外标记 warning。 */
export function nodeStatus(node) {
  if (!node?.online) return { dot: 'idle', label: '离线', tone: 'muted' };
  if (node.private_network === false) return { dot: 'warning', label: '在线 · 非内网', tone: 'warning' };
  return { dot: 'active', label: '在线', tone: 'success' };
}

/** 节点上报的可用编程工具，未就绪的标注原因。 */
export function nodeProviderSummary(node) {
  const providers = Array.isArray(node?.info?.providers) ? node.info.providers : [];
  if (providers.length === 0) return node?.last_seen_at ? '未发现可用编程工具' : '尚未连接';
  return providers.map(provider => (provider.ready ? provider.id : `${provider.id}（不可用）`)).join(' · ');
}

/** 节点上可用于新项目的编程工具 id 列表。 */
export function nodeReadyProviders(node) {
  const providers = Array.isArray(node?.info?.providers) ? node.info.providers : [];
  return providers.filter(provider => provider.ready && provider.capabilities?.includes('issue_execution')).map(provider => provider.id);
}

/** 节点启动命令；密钥经环境变量传入，避免出现在进程列表中。 */
export function nodeStartCommand({ hubUrl, token }) {
  return `XUANWU_NODE_TOKEN=${token} xuanwu node --hub ${hubUrl} --root <项目所在目录>`;
}

export function compactNodePath(path = '') {
  const parts = String(path).split(/[\\/]+/).filter(Boolean);
  return parts.length <= 3 ? path : `…/${parts.slice(-2).join('/')}`;
}

const BUILTIN_AGENT_LABELS = Object.freeze({ codex: 'Codex', claude: 'Claude Code', 'pi-coding-agent': 'Pi', qoder: 'Qoder' });
const REMOTE_CAPABILITY_LABELS = Object.freeze({ sessions: '会话', resume_session: '续跑', model_list: '模型列表', approvals: '审批', interrupt: '中断' });

/** 设置页按节点分组的远程编程工具；名称优先沿用本机同 id 工具（本机检测失败时用内置名），状态以节点在线与上报就绪为准。 */
export function remoteCodeAgentGroups(nodes, localAgents = []) {
  const labels = new Map((Array.isArray(localAgents) ? localAgents : []).map(agent => [agent.id, agent.label || agent.id]));
  return (Array.isArray(nodes) ? nodes : []).filter(node => !node?.revoked_at).map(node => {
    const providers = Array.isArray(node?.info?.providers) ? node.info.providers : [];
    return {
      id: node.id,
      name: node.name || node.id,
      status: nodeStatus(node),
      agents: providers.map(provider => {
        const executable = provider.ready && provider.capabilities?.includes('issue_execution');
        const available = Boolean(node.online && executable);
        return {
          id: provider.id,
          label: labels.get(provider.id) || BUILTIN_AGENT_LABELS[provider.id] || provider.id,
          available,
          status: !node.online ? '节点离线' : available ? '可用' : '未就绪',
          detail: [provider.version ? `版本 ${provider.version}` : '',
            ...(provider.capabilities || []).map(capability => REMOTE_CAPABILITY_LABELS[capability]).filter(Boolean)]
            .filter(Boolean).join(' · '),
        };
      }),
    };
  });
}
