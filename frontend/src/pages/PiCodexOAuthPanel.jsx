import { codexLoginMessage } from './piCredentialSource.js';
import { KeyRound, Loader2, RefreshCw } from 'lucide-react';
import { useI18n } from '../i18n/context.js';

export function CodexOAuthPanel({ state }) {
  const { t } = useI18n();
  const status = state.oauthStatus;
  return (
    <div className="supervisor-oauth-panel">
      <div className="supervisor-oauth-heading">
        <div><strong>{t('credential.storedLogin')}</strong><p>{t('credential.storedHint')}</p></div>
        <OAuthButtons state={state} />
      </div>
      <OAuthStatusLine status={status} />
    </div>
  );
}

function OAuthButtons({ state }) {
  const { language } = useI18n();
  const english = language === 'en-US';
  const configured = Boolean(state.oauthStatus?.pi_oauth?.configured);
  const pending = state.oauthStatus?.status === 'pending' && state.oauthStatus?.auth_url;
  return (
    <div className="supervisor-oauth-controls">
      <button className="btn btn-secondary" onClick={pending ? state.openPiCodexOAuthUrl : state.startPiCodexOAuthLogin} disabled={state.oauthBusy || configured} type="button">
        {state.oauthBusy ? <Loader2 size={14} className="spin-animation" /> : <KeyRound size={14} />} {configured ? (english ? 'Signed in' : '已登录') : (english ? 'Sign in' : '登录')}
      </button>
      <details className="settings-disclosure supervisor-oauth-more">
        <summary>{english ? 'More' : '更多'}</summary>
        <div className="supervisor-oauth-actions">
          <button className="btn btn-secondary" onClick={state.startPiCodexOAuthLogin} disabled={state.oauthBusy} type="button">{english ? 'Authorize again' : '重新授权'}</button>
          <button className="btn btn-secondary" onClick={state.copyPiCodexOAuthUrl} disabled={!state.oauthStatus?.auth_url} type="button">{english ? 'Copy sign-in URL' : '复制登录地址'}</button>
          <button className="btn btn-secondary" onClick={state.openPiCodexOAuthUrl} disabled={!state.oauthStatus?.auth_url} type="button">{english ? 'Open authorization page' : '打开授权页'}</button>
          <button className="btn btn-secondary" onClick={state.loadOAuthStatus} disabled={state.oauthBusy} type="button"><RefreshCw size={14} />{english ? 'Refresh status' : '刷新 OAuth 状态'}</button>
          <button className="btn btn-secondary" onClick={state.logoutPiCodexOAuth} disabled={state.oauthBusy || !configured} type="button">{english ? 'Revoke authorization' : '撤销授权'}</button>
        </div>
        {state.oauthStatus?.auth_url ? <code>{state.oauthStatus.auth_url}</code> : null}
      </details>
    </div>
  );
}

function OAuthStatusLine({ status }) {
  const { language } = useI18n();
  const english = language === 'en-US';
  const lifecycle = status?.status || status?.pi_oauth?.status || 'idle';
  const configured = Boolean(status?.pi_oauth?.configured);
  const label = configured ? (english ? 'Authorized' : '已授权') : (english ? 'Not authorized' : '未授权');
  const detail = status?.message || (lifecycle === 'pending'
    ? (english ? 'Finish authorization in the browser; signing in again creates a new URL.' : '等待浏览器完成授权；再次登录会生成新的授权地址。')
    : lifecycle === 'error' ? (english ? 'Authorization failed. Try again from More.' : '授权失败，可在“更多”中重新授权。') : '');
  return (
    <div className="supervisor-oauth-status">
      <span><i className={configured ? 'ready' : lifecycle} />{english ? 'Authorization' : '授权'}：{label}</span>
      {detail ? <span className={lifecycle === 'error' ? 'oauth-error' : ''}>{detail}</span> : null}
    </div>
  );
}

export function CodexLoginReuse({ state }) {
  const { t } = useI18n();
  const status = state.oauthStatus?.codex_login;
  return (
    <section className="supervisor-oauth-panel">
      <div className="supervisor-oauth-heading">
        <div><strong>{t('credential.reuse')}</strong><p>{t('credential.reuseHint')}</p></div>
      </div>
      <p className="supervisor-oauth-status" role="status">{t('credential.authorization', { status: t(codexLoginMessage(status)) })}</p>
      <div className="supervisor-oauth-controls">
        <button className="btn btn-secondary" disabled={state.oauthBusy} onClick={state.loadOAuthStatus} type="button"><RefreshCw size={14} />{t('credential.refreshStatus')}</button>
        <button className="btn btn-secondary" onClick={state.selectOAuthMode} type="button">{t('credential.switchStored')}</button>
      </div>
      <p className="supervisor-oauth-status">{t('credential.switchHint')}</p>
    </section>
  );
}
