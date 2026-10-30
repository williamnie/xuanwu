import { assistantApi } from '../api/assistant.js';
import { message } from '../store/toastStore';
import { personaDraft, providerPayload, supervisorPayload, formFromState } from './piAgentSettingsForm.js';

export async function savePiConnectionAndSupervisor({ form, setForm, setPersonaConflictDraft, setPromptSummary, setProviders, setSaving }) {
  if (!isValidForm(form)) return false;
  setSaving(true);
  let connectionSaved = false;
  try {
    const providerID = form.modelProvider.trim();
    await assistantApi.updatePiProviderSettings(providerID, providerPayload(form));
    connectionSaved = true;
    await saveSupervisor(supervisorPayload(form));
    setPersonaConflictDraft(null);
    setPromptSummary(null);
    message.success('模型连接已保存并设为玄武助手默认模型');
    await refreshAfterSave(setProviders, setForm);
    return true;
  } catch (err) {
    if (err?.status === 409) {
      setPersonaConflictDraft(personaDraft(form));
      await refreshAfterSave(setProviders, setForm);
      message.error('连接已保存，但表达 Persona revision 已变化；已保留本地草稿，请处理冲突后再保存运行偏好');
      return false;
    }
    message.error(connectionSaved
      ? '连接参数已保存，但设置玄武助手默认模型失败，请重试'
      : err.message || '保存模型连接失败');
    return false;
  } finally {
    setSaving(false);
  }
}

export async function savePiSupervisorSettings({ form, providers, setForm, setPersonaConflictDraft, setPromptSummary, setProviders, setSaving }) {
  if (!isValidAgentForm(form)) return;
  setSaving(true);
  try {
    await ensureSelectedProviderModel(form, providers);
    await saveSupervisor(supervisorPayload(form));
    setPersonaConflictDraft(null);
    message.success('玄武助手行为设置已保存');
    setPromptSummary(null);
    await refreshAfterSave(setProviders, setForm);
  } catch (err) {
    if (err?.status === 409) {
      setPersonaConflictDraft(personaDraft(form));
      await refreshAfterSave(setProviders, setForm);
      message.error('表达 Persona 已被其他修改更新；已重新加载最新 revision，并保留本地草稿供你合并');
      return;
    }
    message.error(err.message || '保存玄武助手行为设置失败');
  } finally {
    setSaving(false);
  }
}

async function ensureSelectedProviderModel(form, providers) {
  const providerID = form.modelProvider.trim();
  const modelID = form.modelId.trim();
  const configured = providers.find((provider) => provider.id === providerID);
  if (configured?.models?.includes(modelID)) return;
  await assistantApi.updatePiProviderSettings(providerID, providerPayload(form));
}

async function saveSupervisor(payload) {
  return await assistantApi.updatePiSupervisor(payload);
}

export async function refreshAfterSave(setProviders, setForm) {
  const [supervisor, providerSettings] = await Promise.all([assistantApi.getPiSupervisor(), assistantApi.getPiProviderSettings()]);
  const nextProviders = providerSettings?.providers || [];
  setProviders(nextProviders);
  setForm({ ...formFromState(supervisor, nextProviders), apiKey: '' });
}

function isValidForm(form) {
  if (form.modelProvider.trim() && form.modelId.trim() && form.api.trim()) return true;
  message.error('API 协议和模型不能为空');
  return false;
}

function isValidAgentForm(form) {
  if (form.modelProvider.trim() && form.modelId.trim()) return true;
  message.error('请先在上方选择默认模型');
  return false;
}
