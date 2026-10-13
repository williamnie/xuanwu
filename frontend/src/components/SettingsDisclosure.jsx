import { useState } from 'react';

// 首次展开才挂载，收起后保持同一份草稿。深链变化时只打开目标节。
export default function SettingsDisclosure({ children, id, title, selected = false }) {
  const [state, setState] = useState({ selected, open: selected, visited: selected });
  if (state.selected !== selected) {
    setState(current => ({ ...current, selected, open: selected || current.open, visited: selected || current.visited }));
  }
  return (
    <details className="settings-disclosure" id={id} open={state.open} onToggle={event => {
      const open = event.currentTarget.open;
      setState(current => current.open === open && (!open || current.visited) ? current : { ...current, open, visited: current.visited || open });
    }}>
      <summary><strong>{title}</strong></summary>
      {state.visited ? <div className="settings-disclosure-content">{children}</div> : null}
    </details>
  );
}
