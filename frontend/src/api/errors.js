/**
 * 所有 JSON API 与上传请求共用的错误类型。
 *
 * 保留旧 client 的 `Error`、`message` 与 `status` 语义，同时给调用方一个
 * 可稳定判断的具体类型。
 */
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
