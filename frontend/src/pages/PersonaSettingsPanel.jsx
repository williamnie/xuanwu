import { useCallback, useEffect, useState } from 'react';
import { assistantApi } from '../api/assistant.js';
import { PanelLoader } from '../components/TurtleLoader';
import { ChatPersonaSettings } from './PiAgentSettingsPanel.jsx';
import { formFromState, supervisorPayload } from './piAgentSettingsState.js';
import { message } from '../store/toastStore.js';

export default function PersonaSettingsPanel() {
  const [form,setForm]=useState(null);const [saving,setSaving]=useState(false);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const [conflict,setConflict]=useState(null);const [conflictNeedsRefresh,setConflictNeedsRefresh]=useState(false);
  const load=useCallback(async()=>{setLoading(true);try{setForm(formFromState(await assistantApi.getPiSupervisor(),[]));setConflictNeedsRefresh(false);setError('');}catch(error){setConflictNeedsRefresh(true);setError(error.message);}finally{setLoading(false);}},[]);
  useEffect(()=>{load();},[load]);
  const save=async()=>{if(!form||saving)return;setSaving(true);setError('');try{
    // 本区域只写 persona，不发送名称、模型、连接或长期说明，避免覆盖AI分区草稿。
    await assistantApi.updatePiSupervisor({persona:supervisorPayload({...form,personaDirty:true}).persona});
    setConflict(null);await load();message.success('表达风格已保存');
  }catch(error){if(error.status===409){setConflict(form);await load();setError('表达风格已被更新，请比较服务器配置和本地草稿');}else setError(error.message);}finally{setSaving(false);}};
  if(loading&&!form)return <PanelLoader label="正在读取表达风格…"/>;
  const state={form,saving,personaConflictDraft:conflict,personaConflictNeedsRefresh:conflictNeedsRefresh,updateField:(key,value)=>setForm(current=>({...current,[key]:value,personaDirty:true})),restorePersonaConflictDraft:()=>{if(conflictNeedsRefresh)return;setForm(current=>({...current,...conflict,personaRevision:current.personaRevision,personaDirty:true}));setConflict(null);setError('');},dismissPersonaConflictDraft:()=>{if(conflictNeedsRefresh)return;setConflict(null);setError('');}};
  return <section className="persona-settings-panel"><h3>表达风格</h3>{error&&<p role="alert">{error}</p>}{conflictNeedsRefresh&&<button className="btn btn-secondary" onClick={load} type="button">读取服务器配置</button>}{form?<><fieldset disabled={saving||loading} className="persona-settings-fields"><ChatPersonaSettings state={state}/></fieldset><button className="btn btn-secondary" disabled={saving||loading} onClick={save} type="button">{saving?'保存中…':'保存表达风格'}</button></>:<button className="btn btn-secondary" onClick={load} type="button">重试读取</button>}</section>;
}
