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
  let chunks: Uint8Array[] = [];
  let bufferedBytes = 0;
  let waitingForRead = false;
  let streamClosed = false;
  let closed = false;
  const onAbort = () => abort();
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    },
    pull() {
      waitingForRead = true;
      flush();
    },
    cancel() {
      streamClosed = true;
      discard();
      cleanup();
    }
  }, {
    // 自己持有积压，断线时可丢弃；只在消费者请求数据时交给流。
    highWaterMark: 0
  });

  function cleanup(): void {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener("abort", onAbort);
    options.onClose?.();
  }

  function abort(): void {
    if (streamClosed) return;
    discard();
    cleanup();
    flush();
  }

  function close(): void {
    if (closed) return;
    cleanup();
    flush();
  }

  function write(value: string): boolean {
    if (closed) return false;
    // UTF-8 字节数不小于 UTF-16 长度，先拒绝显然超限的数据以避免额外大分配。
    if (value.length > maxBufferBytes) return overflow();
    const chunk = encoder.encode(value);
    if (chunk.byteLength > maxBufferBytes - bufferedBytes) return overflow();
    chunks.push(chunk);
    bufferedBytes += chunk.byteLength;
    flush();
    return true;
  }

  function discard(): void {
    chunks = [];
    bufferedBytes = 0;
  }

  function flush(): void {
    if (streamClosed) return;
    if (waitingForRead && chunks.length > 0) {
      const chunk = chunks.shift()!;
      bufferedBytes -= chunk.byteLength;
      waitingForRead = false;
      controller.enqueue(chunk);
    }
    if (closed && chunks.length === 0) {
      streamClosed = true;
      // Bun 1.3.10 在 HTTP 响应断线时对 controller.error 产生未处理拒绝，
      // 会退出整个 Core。结束传输即可让 SSE 客户端重连，不向 HTTP sink 注入错误。
      controller.close();
    }
  }

  function overflow(): false {
    abort();
    return false;
  }

  return { stream, write, close, abort, get closed() { return closed; } };
}
