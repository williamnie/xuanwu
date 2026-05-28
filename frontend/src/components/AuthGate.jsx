import { useState } from 'react';
import { setAuthToken } from '../api/authToken';

export default function AuthGate({ onUnlock }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

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
        <div>
          <div className="auth-eyebrow">Remote access token</div>
          <h1 className="auth-title">Codex Issue Runner</h1>
          <p className="auth-copy">请输入访问 token。后续 API 请求会自动携带该 token。</p>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label htmlFor="runner-auth-token">Token</label>
          <input
            id="runner-auth-token"
            className="form-control"
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoFocus
          />
        </div>
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={!token.trim() || submitting}>
          {submitting ? '校验中...' : '保存并进入'}
        </button>
      </form>
    </div>
  );
}
