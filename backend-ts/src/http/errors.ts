const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8"
} as const;

type ResponseHeaders = ConstructorParameters<typeof Headers>[0];
type JsonResponseInit = Omit<ResponseInit, "headers"> & { headers?: ResponseHeaders };

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export class JsonBodyParseError extends HttpError {
  constructor() {
    super(400, "invalid json body");
    this.name = "JsonBodyParseError";
  }
}

export function json(value: unknown, init: JsonResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", JSON_HEADERS["content-type"]);
  return new Response(JSON.stringify(value), { ...init, headers });
}

export function jsonError(status: number, message: string, headers?: ResponseHeaders): Response {
  return json({ message }, { status, headers });
}

export async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new JsonBodyParseError();
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonError(error.status, error.message);
  }
  return jsonError(500, "internal server error");
}
