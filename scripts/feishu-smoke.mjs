#!/usr/bin/env bun
import { calculateFeishuCallbackSignature } from "../backend-ts/src/integrations/feishuCallback.ts";
import { buildFeishuConnectorConfig, feishuConnectorStatus } from "../backend-ts/src/integrations/feishu.ts";
import { redactSensitiveText } from "../backend-ts/src/util/redact.ts";

const DEFAULT_ADDR = "127.0.0.1:3008";
const PATH = "/api/integrations/feishu/events";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = String(args.mode || "check");
  const config = buildFeishuConnectorConfig(process.env);
  if (mode === "check") return printConfigStatus(config);
  if (mode === "challenge") return await postChallenge(args, config);
  if (mode === "message") return await postMessage(args, config);
  throw new Error(`unknown mode: ${mode}`);
}

function printConfigStatus(config) {
  const status = feishuConnectorStatus(config);
  printSafe({
    ok: status.status === "configured",
    status: status.status,
    callback_path: PATH,
    missing_required: status.missing_required,
    secrets: status.secrets,
    allowed_chat_count: status.allowed_chat_count,
    allowed_user_count: status.allowed_user_count,
    project_mapping_count: status.project_mapping_count,
    auto_reply: status.auto_reply
  }, config);
}

async function postChallenge(args, config) {
  requireConfigured(config);
  const response = await postCallback(args, config, {
    challenge: String(args.challenge || "codex-runner-feishu-smoke"),
    token: config.verificationToken,
    type: "url_verification"
  });
  printSafe(response, config);
}

async function postMessage(args, config) {
  requireConfigured(config);
  const messageId = String(args.messageId || `om_smoke_${Date.now()}`);
  const response = await postCallback(args, config, {
    header: { event_id: `event_${messageId}`, event_type: "im.message.receive_v1", token: config.verificationToken },
    event: {
      message: {
        chat_id: String(args.chatId || "oc_smoke"),
        chat_type: String(args.chatType || "group"),
        content: JSON.stringify({ text: String(args.text || "@PI codex runner Feishu smoke") }),
        create_time: String(Date.now()),
        mentions: [{ id: "ou_bot", name: "PI", tenant_key: "tenant_smoke" }],
        message_id: messageId,
        parent_id: String(args.threadId || "")
      },
      sender: {
        sender_id: { open_id: String(args.openId || "ou_smoke_open"), user_id: String(args.userId || "ou_smoke_user") },
        sender_type: "user",
        tenant_key: "tenant_smoke"
      }
    },
    schema: "2.0"
  });
  printSafe(response, config);
}

async function postCallback(args, config, body) {
  const rawBody = JSON.stringify(body);
  const headers = { "content-type": "application/json" };
  if (config.encryptKey) Object.assign(headers, signatureHeaders(config.encryptKey, rawBody));
  const response = await fetch(callbackUrl(args), { body: rawBody, headers, method: "POST" });
  const text = await response.text();
  return {
    body: parseMaybeJson(text),
    ok: response.ok,
    status: response.status,
    url: callbackUrl(args)
  };
}

function signatureHeaders(encryptKey, rawBody) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = `smoke-${Date.now()}`;
  return {
    "x-lark-request-nonce": nonce,
    "x-lark-request-timestamp": timestamp,
    "x-lark-signature": calculateFeishuCallbackSignature({ encryptKey, nonce, rawBody, timestamp })
  };
}

function callbackUrl(args) {
  const raw = String(args.url || "").trim();
  if (raw) return raw;
  const addr = String(args.addr || process.env.CODEX_RUNNER_ADDR || DEFAULT_ADDR);
  const base = addr.startsWith("http") ? addr : `http://${addr}`;
  return `${base.replace(/\/+$/, "")}${PATH}`;
}

function requireConfigured(config) {
  const status = feishuConnectorStatus(config);
  if (status.status !== "configured") throw new Error(`Feishu connector not configured: missing ${status.missing_required.join(",")}`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [key, inline] = arg.slice(2).split("=", 2);
    out[toCamel(key)] = inline ?? argv[++i] ?? "";
  }
  return out;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function parseMaybeJson(text) {
  try { return JSON.parse(text); } catch { return text; }
}

function printSafe(value, config) {
  const json = JSON.stringify(value, null, 2);
  const redacted = [config.appSecret, config.encryptKey, config.verificationToken]
    .reduce((current, secret) => secret ? current.split(secret).join("[redacted]") : current, redactSensitiveText(json));
  console.log(redacted);
}

main().catch((error) => {
  console.error(redactSensitiveText(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
