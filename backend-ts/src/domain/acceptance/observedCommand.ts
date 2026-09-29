/** Provider 可把命令记录为 /bin/zsh -lc 'script'；只去掉这层 argv 包装，不模糊匹配命令内容。 */
export function sameObservedCommand(observed: string, reported: string): boolean {
  const unwrap = (value: string): string => {
    const match = /^(?:\/(?:[^\s/]+\/)*|)(?:bash|zsh|sh|dash)\s+-(?:lc|c)\s+([\s\S]+)$/.exec(value.trim());
    if (!match) return value.trim();
    const encoded = match[1]!;
    let quote = ""; let output = "";
    for (let i = 0; i < encoded.length; i++) {
      const char = encoded[i]!;
      if (!quote && /\s|[;&|<>()[\]`$]/.test(char)) return value.trim();
      if (!quote && (char === "'" || char === '"')) { quote = char; continue; }
      if (quote && char === quote) { quote = ""; continue; }
      if (char === "\\" && quote !== "'") {
        const next = encoded[++i];
        if (next === undefined) return value.trim();
        output += quote === '"' && !/[\\"$`\n]/.test(next) ? `\\${next}` : next === "\n" ? "" : next;
      } else output += char;
    }
    return quote ? value.trim() : output.trim();
  };
  return unwrap(observed) === unwrap(reported);
}
