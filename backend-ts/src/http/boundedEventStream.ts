const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;

type BoundedEventStreamOptions = {
  maxBufferBytes?: number;
  signal?: AbortSignal;
  onClose?: () => void;
};

/** 限制每个连接积压的字节数；慢客户端断开后应重连并重新读取快照。 */
export function createBoundedEventStream(options: BoundedEventStreamOptions = {}) {
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes <= 0) {
    throw new RangeError("maxBufferBytes must be a positive safe integer");
  }
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const onAbort = () => abort(options.signal?.reason);
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    },
    cancel() {
      cleanup();
    }
  }, {
    highWaterMark: maxBufferBytes,
    size: (chunk) => chunk?.byteLength ?? 0
  });

  function cleanup(): void {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener("abort", onAbort);
    options.onClose?.();
  }

  function abort(reason: unknown = new Error("SSE connection aborted")): void {
    if (closed) return;
    controller.error(reason);
    cleanup();
  }

  function close(): void {
    if (closed) return;
    controller.close();
    cleanup();
  }

  function write(value: string): boolean {
    if (closed) return false;
    // UTF-8 字节数不小于 UTF-16 长度，先拒绝显然超限的数据以避免额外大分配。
    if (value.length > maxBufferBytes) return overflow();
    const chunk = encoder.encode(value);
    if (chunk.byteLength > (controller.desiredSize ?? 0)) return overflow();
    controller.enqueue(chunk);
    return true;
  }

  function overflow(): false {
    // error 会立即释放旧队列；close 则仍会为慢客户端保留全部积压。
    abort(new Error("SSE buffer limit exceeded; reconnect and reload the snapshot"));
    return false;
  }

  return { stream, write, close, abort, get closed() { return closed; } };
}
