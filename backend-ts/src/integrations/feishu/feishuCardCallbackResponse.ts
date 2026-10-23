export function projectSelectionCallbackAcceptedBody(): Record<string, unknown> {
  return {
    toast: {
      content: "已收到项目选择，正在继续处理。",
      type: "info"
    }
  };
}
