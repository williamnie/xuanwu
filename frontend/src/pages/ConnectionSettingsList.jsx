import { useCallback, useEffect, useState } from 'react';
import { connectorsApi } from '../api/connectors.js';
import { githubSettingsApi } from '../api/githubSettings.js';
import SettingsDrawer from '../components/SettingsDrawer.jsx';
import SettingsDisclosure from '../components/SettingsDisclosure.jsx';
import GitHubSettingsPanel from './GitHubSettingsPanel.jsx';
import FeishuSettingsPanel from './FeishuSettingsPanel.jsx';
import TelegramSettingsPanel from './TelegramSettingsPanel.jsx';
import ConnectorDiagnosticsPanel from './ConnectorDiagnosticsPanel.jsx';

const PLATFORMS=[['github','GitHub'],['feishu','飞书'],['telegram','Telegram']];
export default function ConnectionSettingsList({active = true}){
  const [state,setState]=useState({connectors:[],github:null,error:''});const [channel,setChannel]=useState('');const [visited,setVisited]=useState([]);
  const load=useCallback(async()=>{
    const [connectors,github]=await Promise.allSettled([connectorsApi.getPiConnectors().then(data=>{if(!Array.isArray(data?.connectors))throw new Error('连接状态响应不完整');return data;}),githubSettingsApi.get()]);
    setState(current=>({connectors:connectors.status==='fulfilled'?connectors.value.connectors||[]:current.connectors,github:github.status==='fulfilled'?github.value:current.github,error:[connectors,github].filter(result=>result.status==='rejected').map(result=>result.reason.message).join('；')}));
  },[]);
  useEffect(()=>{load();},[load]);
  const open=id=>{setVisited(current=>current.includes(id)?current:[...current,id]);setChannel(id);};
  const close=()=>{setChannel('');load();};
  const connectionLabel=id=>{
    if(id==='github'&&state.github){if(!state.github.settings?.enabled&&!state.github.settings?.repositories?.length)return '未连接';if(state.github.runtime?.last_error)return '异常';if(state.github.application?.status==='pending')return '已保存待生效';if(state.github.application?.status==='unavailable')return '待服务恢复';return state.github.settings?.enabled?'已生效':'未启用';}
    const connector=state.connectors.find(item=>item.id===id||item.id?.startsWith(`${id}-`));
    if(!connector)return '未连接';if(['error','misconfigured'].includes(connector.status)||connector.health?.ok===false)return '异常';if(connector.notification?.error)return '最近发送失败';if(connector.status==='connected')return '已连接';return connector.status==='configured'?'已配置':'未连接';
  };
  return <section className="settings-connections-list" id="settings-integrations"><h3>外部连接</h3>{state.error&&<p role="alert">连接状态部分读取失败：{state.error}</p>}{PLATFORMS.map(([id,title])=><div className="settings-connection-row" key={id}><strong>{title}</strong><span>{connectionLabel(id)}{state.connectors.find(connector=>connector.id===id)?.notification?.error?.message?`：${state.connectors.find(connector=>connector.id===id).notification.error.message}`:''}</span><button className="btn btn-secondary" onClick={()=>open(id)} type="button">{connectionLabel(id)==='未连接'?'连接':'管理'} {title}</button></div>)}
    {visited.map(id=><SettingsDrawer open={active&&channel===id} key={id} title={PLATFORMS.find(([key])=>key===id)[1]} onClose={close}>{id==='github'?<GitHubSettingsPanel/>:id==='feishu'?<FeishuSettingsPanel/>:<TelegramSettingsPanel/>}<SettingsDisclosure title="连接诊断与授权管理"><ConnectorDiagnosticsPanel connectorPrefix={id}/></SettingsDisclosure></SettingsDrawer>)}
  </section>;
}
export function GitHubActiveRules(){
  const [state,setState]=useState({remote:null,error:''});
  useEffect(()=>{let active=true;githubSettingsApi.get().then(remote=>{if(active)setState({remote,error:''});}).catch(error=>{if(active)setState({remote:null,error:error.message});});return()=>{active=false;};},[]);
  return <section><h3>GitHub 当前生效规则</h3>{state.error&&<p role="alert">{state.error}</p>}{state.remote?<pre>{JSON.stringify(state.remote.application.active_settings,null,2)}</pre>:!state.error&&<p role="status">正在读取规则…</p>}</section>;
}
