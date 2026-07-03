export default function PromptSuggestionMenu({ items, activeIndex, onPick }) {
  return (
    <div className="prompt-suggestion-menu" role="listbox" aria-label="输入建议">
      {items.map((item, index) => (
        <button
          key={item.id || `${item.trigger}-${item.label}`}
          type="button"
          className={`prompt-suggestion-item ${index === activeIndex ? 'active' : ''}`}
          role="option"
          aria-selected={index === activeIndex}
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(item);
          }}
        >
          <span className="prompt-suggestion-label">{item.label}</span>
          {item.description && <span className="prompt-suggestion-description">{item.description}</span>}
        </button>
      ))}
      <div className="prompt-suggestion-hint">↑↓ 选择 · Enter 插入 · Esc 关闭</div>
    </div>
  );
}
