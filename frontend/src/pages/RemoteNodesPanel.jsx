import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Plus, RefreshCw, Server, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react';
import { nodesApi } from '../api/nodes.js';
import { message } from '../store/toastStore.js';
import { isPrivateHubHost, nodeProviderSummary, nodeStartCommand, nodeStatus } from './remoteNodesModel.js';
import './RemoteNodesPanel.css';

// 远程节点：装了 Agent 端的其他机器主动连回中心，中心即可调度它们上面的项目与编程工具。
export default function RemoteNodesPanel() {
  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null);
  const [revokingId, setRevokingId] = useState('');
  const [confirmRevokeId, setConfirmRevokeId] = useState('');
  const hubUrl = window.location.origin;
  const publicHub = !isPrivateHubHost(window.location.hostname);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await nodesApi.listNodes();
      setNodes(Array.isArray(result?.nodes) ? result.nodes : []);
      setError('');
    } catch (err) {
      setError(err.message || '读取远程节点失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const create = async (event) => {
    event.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      const result = await nodesApi.createNode(name.trim());
      setCreated({ name: result.node.name, token: result.token });
      setAdding(false);
      setName('');
      await load();
    } catch (err) {
      message.error(err.message || '添加节点失败');
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (node) => {
    setRevokingId(node.id);
    try {
      await nodesApi.revokeNode(node.id);
      message.success(`节点 ${node.name} 已移除，它将立即断开`);
      setConfirmRevokeId('');
      await load();
    } catch (err) {
      message.error(err.message || '移除节点失败');
    } finally {
      setRevokingId('');
    }
  };

  const copyCommand = async () => {
    try {
      await copyText(nodeStartCommand({ hubUrl, token: created.token }));
      message.success('启动命令已复制');
    } catch (err) {
      message.error(err.message || '复制失败');
    }
  };

  return (
    <section className="glass-card remote-nodes-panel" aria-labelledby="remote-nodes-title">
      <div className="remote-nodes-header">
        <div>
          <div className="settings-entry-eyebrow">Remote nodes</div>
          <h2 id="remote-nodes-title"><Server size={16} /> 远程节点</h2>
          <p>在其他机器上运行 Agent 端，玄武就能调度那台机器上的项目和编程工具。建议通过 Tailscale 等内网组网连接。</p>
        </div>
        <div className="remote-nodes-actions">
          <button className="btn btn-secondary" disabled={loading} onClick={load} type="button" aria-label="刷新节点列表">
            <RefreshCw className={loading ? 'spin-animation' : ''} size={14} />刷新
          </button>
          <button className="btn btn-secondary" disabled={adding || Boolean(created)} onClick={() => setAdding(true)} type="button">
            <Plus size={14} />添加节点
          </button>
        </div>
      </div>

      {error && <div className="settings-inline-error" role="alert">{error}</div>}

      {adding && (
        <form className="remote-nodes-form" onSubmit={create}>
          <label className="form-group">
            <span className="ds-mono-label">节点名称</span>
            <input autoFocus className="form-control" maxLength={64} onChange={event => setName(event.target.value)} placeholder="例如：工作室 MacBook" value={name} />
          </label>
          {publicHub && (
            <div className="remote-nodes-warning" role="status">
              <TriangleAlert size={14} />
              <span>当前中心地址 {window.location.hostname} 不是内网地址。测试版未针对公网加固，建议改用 Tailscale 等内网地址访问后再添加节点。</span>
            </div>
          )}
          <div className="remote-nodes-form-actions">
            <button className="btn btn-secondary" disabled={creating} onClick={() => { setAdding(false); setName(''); }} type="button">取消</button>
            <button className="btn btn-secondary" disabled={creating || !name.trim()} type="submit">{creating ? '正在添加…' : '生成密钥'}</button>
          </div>
        </form>
      )}

      {created && (
        <div className="remote-nodes-reveal" role="status">
          <div className="remote-nodes-reveal-heading">
            <div><ShieldCheck size={14} /><strong>{created.name} 的密钥只显示这一次</strong></div>
            <button className="btn btn-secondary" onClick={copyCommand} type="button"><Copy size={14} />复制命令</button>
          </div>
          <p>在节点机器上执行下面的命令，把 <code>&lt;项目所在目录&gt;</code> 换成允许玄武工作的目录（可重复 --root）。节点连上后会出现在下方列表。长期运行时把 <code>xuanwu node</code> 换成 <code>xuanwu node install --start</code>，会注册为开机自启的服务。</p>
          <code className="remote-nodes-command">{nodeStartCommand({ hubUrl, token: created.token })}</code>
          <button className="btn btn-secondary" onClick={() => setCreated(null)} type="button"><Check size={14} />我已保存</button>
        </div>
      )}

      {!loading && nodes.length === 0 && !adding && !created ? (
        <p className="remote-nodes-empty">还没有远程节点。添加后，可在添加项目时选择项目所在的节点。</p>
      ) : (
        <ul className="remote-nodes-list">
          {nodes.map(node => {
            const status = nodeStatus(node);
            const confirming = confirmRevokeId === node.id;
            return (
              <li className="remote-node-row" key={node.id}>
                <div className="remote-node-main">
                  <div className="remote-node-title">
                    <span className={`status-dot ${status.dot}`} aria-hidden="true" />
                    <strong>{node.name}</strong>
                    <span className={`remote-node-state is-${status.tone}`}>{status.label}</span>
                  </div>
                  <div className="remote-node-meta">
                    <span><span className="ds-mono-label">Host</span>{node.info?.hostname || '—'}</span>
                    <span><span className="ds-mono-label">Address</span>{node.last_remote_addr || '—'}</span>
                    <span><span className="ds-mono-label">Tools</span>{nodeProviderSummary(node)}</span>
                  </div>
                  {node.version_mismatch && (
                    <p className="remote-nodes-warning-text">节点版本 {node.info?.version} 与中心 {node.hub_version} 不一致，请在节点上升级 xuanwu 后重启节点服务。</p>
                  )}
                  {node.private_network === false && (
                    <p className="remote-nodes-warning-text">该节点通过非内网地址连接，测试版未针对公网加固，建议改用 Tailscale 等内网组网。</p>
                  )}
                </div>
                {confirming ? (
                  <div className="remote-node-confirm">
                    <span>移除后节点立即断开，它上面的项目将无法执行。</span>
                    <button className="btn btn-secondary" disabled={revokingId === node.id} onClick={() => setConfirmRevokeId('')} type="button">取消</button>
                    <button className="btn btn-secondary btn-danger" disabled={revokingId === node.id} onClick={() => revoke(node)} type="button">
                      {revokingId === node.id ? '正在移除…' : '确认移除'}
                    </button>
                  </div>
                ) : (
                  <button
                    aria-label={`移除节点 ${node.name}`}
                    className="btn btn-secondary btn-danger project-card-icon-btn"
                    onClick={() => setConfirmRevokeId(node.id)}
                    title="移除"
                    type="button"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const textarea = document.createElement('textarea');
  textarea.value = text;
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
  return Promise.resolve();
}
