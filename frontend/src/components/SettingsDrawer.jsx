import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import './SettingsDrawer.css';

export default function SettingsDrawer({ open, title, onClose, children }) {
  const ref=useRef(null);const closeRef=useRef(onClose);
  useEffect(()=>{closeRef.current=onClose;},[onClose]);
  useEffect(()=>{
    if(!open)return;
    const previous=document.activeElement;const root=document.getElementById('root');const inert=root?.inert;const overflow=document.body.style.overflow;
    if(root)root.inert=true;document.body.style.overflow='hidden';
    const frame=requestAnimationFrame(()=>ref.current?.querySelector('button,input,select,textarea')?.focus());
    const keydown=event=>{
      if(event.key==='Escape'){event.preventDefault();closeRef.current();return;}
      if(event.key!=='Tab')return;
      const elements=[...ref.current?.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex="0"]')||[]].filter(element=>element.getClientRects().length>0);
      const first=elements[0],last=elements.at(-1);
      if(!first){event.preventDefault();ref.current?.focus();return;}
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    };
    document.addEventListener('keydown',keydown);
    return()=>{cancelAnimationFrame(frame);document.removeEventListener('keydown',keydown);if(root)root.inert=inert;document.body.style.overflow=overflow;previous?.focus?.();};
  },[open]);
  return createPortal(<div className="settings-drawer-backdrop" hidden={!open} onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}><section className="settings-drawer" aria-label={title} aria-modal="true" role="dialog" tabIndex={-1} ref={ref}><header><h2>{title}</h2><button className="btn btn-secondary" aria-label="关闭连接配置" onClick={onClose} type="button"><X size={14}/></button></header>{children}</section></div>,document.body);
}
