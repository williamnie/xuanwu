import { useEffect, useState } from 'react';
import { Check, Copy, KeyRound, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { setAuthToken } from '../api/authToken.js';
import { systemApi } from '../api/system.js';
import { message } from '../store/toastStore.js';

export default function RemoteAccessTokenPanel() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [revealedToken, setRevealedToken] = useState('');

  useEffect(() => {
    systemApi.getAuthTokenStatus()
      .then(value => { setStatus(value); setError(''); })
      .catch(err => setError(err.message || '读取 Remote access token 状态失败'))
      .finally(() => setLoading(false));
  }, []);

  const rotate = async () => {
    setRotating(true);
    setError('');
    try {
      const result = await systemApi.rotateAuthToken();
      setAuthToken(result.token);
      setRevealedToken(result.token);
      setConfirming(false);
      message.success('Remote access token 已轮换；其他浏览器需要使用新 token 重新连接');
    } catch (err) {
      setError(err.message || '轮换 Remote access token 失败');
    } finally {
      setRotating(false);
    }
  };

  const copy = async () => {
    try {
      await copyText(revealedToken);
      message.success('新 token 已复制');
    } catch (err) {
      message.error(err.message || '复制失败');
    }
  };

  return (
    <section className="glass-card remote-token-panel">
      <div className="remote-token-header">
        <div>
          <div className="settings-entry-eyebrow">Access security</div>
          <h2><KeyRound size={18} /> Remote access token</h2>
          <p>保护 Web UI、API 和内部 Agentic Worker。token 永远不会出现在状态接口或诊断日志中。</p>
        </div>
        <TokenStatus status={status} loading={loading} />
      </div>

      {error && <div className="settings-inline-error" role="alert">{error}</div>}

      {revealedToken ? (
        <div className="remote-token-reveal" role="status">
          <div className="remote-token-reveal-heading">
            <div><ShieldCheck size={18} /><strong>新 token 只显示这一次</strong></div>
            <button className="btn btn-secondary" onClick={copy} type="button"><Copy size={15} />复制</button>
          </div>
          <code>{revealedToken}</code>
          <p>当前浏览器已经切换到新 token。请立即保存；其他浏览器中的旧 token 已失效。</p>
          <button className="btn btn-primary" onClick={() => setRevealedToken('')} type="button"><Check size={15} />我已保存</button>
        </div>
      ) : confirming ? (
        <div className="remote-token-confirm" role="alert">
          <TriangleAlert size={20} />
          <div>
            <strong>确认轮换 Remote access token？</strong>
            <p>旧 token 会立即失效，其他浏览器和使用该 token 的 API 客户端都需要重新配置。</p>
            <div className="remote-token-actions">
              <button className="btn btn-secondary" disabled={rotating} onClick={() => setConfirming(false)} type="button">取消</button>
              <button className="btn btn-primary" disabled={rotating} onClick={rotate} type="button">
                <RefreshCw className={rotating ? 'spin-animation' : ''} size={15} />
                {rotating ? '正在轮换…' : '生成并替换'}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="remote-token-summary">
          <div>
            <strong>{status?.source === 'environment' ? '由服务器环境变量管理' : '由服务器安全文件管理'}</strong>
            <p>{status?.source === 'environment'
              ? '环境变量优先级最高；请在部署环境中更改并重启服务。'
              : '可在这里生成新 token。文件会以 0600 权限原子替换，运行中的服务会自动加载。'}</p>
          </div>
          <button className="btn btn-secondary" disabled={loading || !status?.rotatable} onClick={() => setConfirming(true)} type="button">
            <RefreshCw size={15} />轮换 token
          </button>
        </div>
      )}
    </section>
  );
}

function TokenStatus({ loading, status }) {
  if (loading) return <span className="remote-token-badge">正在确认…</span>;
  return (
    <span className="remote-token-badge active">
      <ShieldCheck size={14} />{status?.configured ? '已启用' : '未配置'}
    </span>
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
