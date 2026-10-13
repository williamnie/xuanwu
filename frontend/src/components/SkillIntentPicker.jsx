import { useEffect, useMemo, useState } from 'react';
import { assistantApi } from '../api/assistant.js';
import { parseIntentText } from '../utils/agentProfiles.js';

export default function SkillIntentPicker({ value, onChange }) {
  const [catalog,setCatalog]=useState([]);const [query,setQuery]=useState('');const [error,setError]=useState('');
  const selected=useMemo(()=>parseIntentText(value),[value]);
  useEffect(()=>{let active=true;assistantApi.getPiSkills().then(data=>{if(active)setCatalog(Array.isArray(data)?data:data.skills||data.items||[]);}).catch(error=>{if(active)setError(error.message);});return()=>{active=false;};},[]);
  const options=[...new Map([...catalog.map(skill=>({id:skill.id||skill.name,label:skill.name||skill.title||skill.id})),...selected.filter(id=>!catalog.some(skill=>(skill.id||skill.name)===id)).map(id=>({id,label:`${id}（手填）`}))].filter(item=>item.id).map(item=>[item.id,item])).values()].filter(item=>`${item.id} ${item.label}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="skill-intent-picker"><label>搜索技能意图<input className="form-control" aria-label="搜索技能意图" value={query} onChange={event=>setQuery(event.target.value)}/></label>{error&&<p role="status">技能目录暂不可用，仍可手动填写。</p>}<div className="skill-intent-options">{options.map(item=><label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} onChange={event=>onChange((event.target.checked?[...selected,item.id]:selected.filter(id=>id!==item.id)).join(', '))}/>{item.label}</label>)}</div><label>手动填写<input className="form-control" value={value} onChange={event=>onChange(event.target.value)} placeholder="多个意图用逗号分隔"/></label></div>;
}
