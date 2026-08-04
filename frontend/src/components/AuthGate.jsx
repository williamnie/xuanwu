import { useState } from 'react';
import { Eye, EyeOff, KeyRound, Terminal } from 'lucide-react';
import { setAuthToken } from '../api/authToken';
import { BRAND } from '../brand';
import BrandMark from './BrandMark';

export default function AuthGate({ onUnlock }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [visible, setVisible] = useState(false);

  const submitToken = async (event) => {
    event.preventDefault();
    const value = token.trim();
    if (!value) return;
    setSubmitting(true);
    setError('');
    try {
      setAuthToken(value);
      await onUnlock();
    } catch (err) {
      setAuthToken('');
      setError(err?.message || 'Token 校验失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-gate">
      <form className="glass-card auth-card" onSubmit={submitToken}>
        <div className="auth-brand-panel">
          <BrandMark className="auth-brand" />
          <div>
            <div className="auth-eyebrow"><KeyRound size={13} /> 首次连接</div>
            <h1 className="auth-title">连接 {BRAND.hanzi} {BRAND.name}</h1>
            <p className="auth-copy">安装时生成的 Remote access token 用于确认你有权管理这台玄武。保存后，当前浏览器会自动携带它。</p>
          </div>
        </div>
        <div className="auth-token-guide">
          <div className="auth-token-guide-title"><Terminal size={15} /> 去哪里找 token</div>
          <p>首次交互安装会在终端显示一次。之后可在服务器执行：</p>
          <code>cat ~/.local/state/xuanwu/auth_token</code>
          <p className="auth-token-guide-note">从源码部署到 macOS 时，部署终端也会打印实际保存路径；自定义路径以 <code>XUANWU_AUTH_TOKEN_FILE</code> 为准。</p>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label htmlFor="runner-auth-token">Token</label>
          <div className="auth-token-input-wrap">
            <input
              id="runner-auth-token"
              className="form-control"
              type={visible ? 'text' : 'password'}
              autoComplete="current-password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoFocus
            />
            <button
              aria-label={visible ? '隐藏 token' : '显示 token'}
              className="auth-token-visibility"
              onClick={() => setVisible(value => !value)}
              type="button"
            >
              {visible ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>
        </div>
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={!token.trim() || submitting}>
          {submitting ? '正在验证…' : '验证并进入'}
        </button>
      </form>
    </div>
  );
}
