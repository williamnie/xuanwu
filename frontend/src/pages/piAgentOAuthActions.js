import { assistantApi } from '../api/assistant.js';
import { message } from '../store/toastStore';

export async function loadPiCodexOAuthStatus(setOauthStatus, setOauthBusy) {
  setOauthBusy(true);
  try {
    setOauthStatus(await assistantApi.getPiCodexOAuthStatus());
  } catch (err) {
    message.error(err.message || '读取 Codex OAuth 状态失败');
  } finally {
    setOauthBusy(false);
  }
}

export async function startPiOAuthLogin(setForm, setOauthBusy, setOauthStatus) {
  setOauthBusy(true);
  try {
    const result = await assistantApi.startPiCodexOAuthLogin();
    setOauthStatus(current => ({ ...current, ...result }));
    applyCodexOAuthPreset(setForm);
    message.success('已生成 Codex OAuth 登录地址，请复制到已登录 ChatGPT 的浏览器打开');
  } catch (err) {
    message.error(err.message || '启动 Codex OAuth 登录失败');
  } finally {
    setOauthBusy(false);
  }
}

export async function copyOAuthUrl(url) {
  if (!url) return message.error('当前没有可复制的 OAuth 登录地址');
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return message.error('当前浏览器不支持直接复制，请手动选中登录地址复制');
  }
  try {
    await navigator.clipboard.writeText(url);
    message.success('已复制 OAuth 登录地址');
  } catch (err) {
    message.error(err.message || '复制 OAuth 登录地址失败');
  }
}

function applyCodexOAuthPreset(setForm) {
  setForm((current) => ({
    ...current,
    api: 'openai-codex-responses',
    apiKey: '',
    baseUrl: '',
    modelId: current.modelId || 'gpt-5.4',
    modelProvider: 'openai-codex',
    credentialSource: 'stored'
  }));
}

export async function logoutPiOAuth(setOauthBusy, setOauthStatus) {
  setOauthBusy(true);
  try {
    const result = await assistantApi.logoutPiCodexOAuth();
    setOauthStatus(current => ({ ...current, ...result }));
    message.success('已退出玄武助手 Codex OAuth');
  } catch (err) {
    message.error(err.message || '退出玄武助手 Codex OAuth 失败');
  } finally {
    setOauthBusy(false);
  }
}

export function openOAuthUrl(url) {
  if (!url || typeof window === 'undefined') return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

export async function loadPiPromptSummary(setPromptSummary, setPromptSummaryLoading) {
  setPromptSummaryLoading(true);
  try {
    setPromptSummary(await assistantApi.getPiSupervisorRuntimePrompt());
  } catch (err) {
    message.error(err.message || '读取生效 prompt 摘要失败');
  } finally {
    setPromptSummaryLoading(false);
  }
}
