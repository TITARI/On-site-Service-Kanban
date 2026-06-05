#!/usr/bin/env node

import crypto from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

const config = {
  wxautoBaseUrl: (process.env.WXAUTO_REST_BASE_URL ?? "http://127.0.0.1:8001").replace(/\/+$/, ""),
  wxautoToken: process.env.WXAUTO_REST_TOKEN ?? "",
  wxautoName: process.env.WXAUTO_NAME ?? "",
  filterMute: (process.env.WXAUTO_FILTER_MUTE ?? "false").toLowerCase() === "true",
  intakeUrl: process.env.INTAKE_URL ?? "http://127.0.0.1:3000/api/integrations/wechat/messages",
  outboundUrl: process.env.OUTBOUND_URL ?? "http://127.0.0.1:3000/api/integrations/wechat/outbound",
  intakeSecret: process.env.INTAKE_SECRET ?? "",
  pollIntervalMs: Number.parseInt(process.env.BRIDGE_POLL_INTERVAL_MS ?? "1200", 10),
  outboundPollIntervalMs: Number.parseInt(process.env.BRIDGE_OUTBOUND_POLL_INTERVAL_MS ?? "1500", 10),
  requestTimeoutMs: Number.parseInt(process.env.BRIDGE_REQUEST_TIMEOUT_MS ?? "10000", 10),
  dedupeWindowSize: Number.parseInt(process.env.BRIDGE_DEDUPE_WINDOW_SIZE ?? "1000", 10),
  dryRun: (process.env.BRIDGE_DRY_RUN ?? "false").toLowerCase() === "true"
};

function assertConfig() {
  const errors = [];
  if (!config.wxautoToken) errors.push("WXAUTO_REST_TOKEN is required.");
  if (!Number.isFinite(config.pollIntervalMs) || config.pollIntervalMs < 300) {
    errors.push("BRIDGE_POLL_INTERVAL_MS must be a number >= 300.");
  }
  if (!Number.isFinite(config.outboundPollIntervalMs) || config.outboundPollIntervalMs < 300) {
    errors.push("BRIDGE_OUTBOUND_POLL_INTERVAL_MS must be a number >= 300.");
  }
  if (!Number.isFinite(config.requestTimeoutMs) || config.requestTimeoutMs < 1000) {
    errors.push("BRIDGE_REQUEST_TIMEOUT_MS must be a number >= 1000.");
  }
  if (!Number.isFinite(config.dedupeWindowSize) || config.dedupeWindowSize < 50) {
    errors.push("BRIDGE_DEDUPE_WINDOW_SIZE must be a number >= 50.");
  }
  if (!config.intakeUrl.startsWith("http://") && !config.intakeUrl.startsWith("https://")) {
    errors.push("INTAKE_URL must start with http:// or https://.");
  }
  if (!config.outboundUrl.startsWith("http://") && !config.outboundUrl.startsWith("https://")) {
    errors.push("OUTBOUND_URL must start with http:// or https://.");
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`[config] ${error}`);
    }
    process.exit(1);
  }
}

function createDedupe(windowSize) {
  const set = new Set();
  const queue = [];
  return {
    has(key) {
      return set.has(key);
    },
    add(key) {
      if (set.has(key)) return;
      set.add(key);
      queue.push(key);
      while (queue.length > windowSize) {
        const evicted = queue.shift();
        if (evicted !== undefined) set.delete(evicted);
      }
    }
  };
}

function hash(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeMessageType(raw) {
  const candidates = [raw.type, raw.msg_type, raw.msgType, raw.message_type];
  const type = candidates.find((item) => typeof item === "string");
  return type ? type.toLowerCase() : "";
}

function pickImageUrls(raw) {
  const candidates = [];
  const maybeArray = [raw.imageUrls, raw.images, raw.image_urls];
  for (const value of maybeArray) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) candidates.push(item.trim());
        if (item && typeof item === "object" && typeof item.url === "string" && item.url.trim()) {
          candidates.push(item.url.trim());
        }
      }
    }
  }

  const singlePath = [raw.path, raw.file_path, raw.image, raw.image_path, raw.url, raw.fileUrl].find(
    (item) => typeof item === "string" && item.trim()
  );
  const type = normalizeMessageType(raw);
  if (singlePath && (type.includes("image") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(singlePath))) {
    candidates.push(singlePath.trim());
  }
  return Array.from(new Set(candidates));
}

function pickText(raw) {
  const fields = [raw.content, raw.text, raw.msg, raw.message, raw.body];
  const text = fields.find((item) => typeof item === "string" && item.trim());
  return text ? text.trim() : "";
}

function pickConversation(raw = {}, chatInfo = {}) {
  const fields = [
    raw.chat_name,
    raw.room_name,
    raw.chatName,
    raw.source_conversation_id,
    chatInfo.chat_name,
    chatInfo.who,
    chatInfo.nickname,
    chatInfo.name
  ];
  const value = fields.find((item) => typeof item === "string" && item.trim());
  return value ? value.trim() : "未知会话";
}

function pickSender(raw, chatInfo) {
  const senderName = [raw.sender, raw.sender_name, raw.from, raw.talker, raw.nickname]
    .find((item) => typeof item === "string" && item.trim()) ?? pickConversation(raw, chatInfo);
  const senderId = [raw.sender_id, raw.from_user_id, raw.fromUserId, raw.wxid, raw.user_id]
    .find((item) => typeof item === "string" && item.trim());
  return {
    senderName: senderName.trim(),
    senderId: senderId?.trim()
  };
}

function messageFingerprint(raw, chatInfo) {
  const normalized = JSON.stringify({
    chat: pickConversation(raw, chatInfo),
    content: pickText(raw),
    type: normalizeMessageType(raw),
    sender: pickSender(raw, chatInfo).senderName,
    ts: normalizeString(raw.time || raw.timestamp || raw.createTime)
  });
  return `wxmsg-${hash(normalized).slice(0, 24)}`;
}

function isSelfOrSystemMessage(raw) {
  if (raw.is_self === true || raw.isSelf === true || raw.self === true) return true;
  if (raw.is_system === true || raw.isSystem === true) return true;
  if (normalizeMessageType(raw).includes("system")) return true;

  const sender = [raw.sender, raw.sender_name, raw.from, raw.talker, raw.nickname]
    .map(normalizeString)
    .find(Boolean)
    ?.toLowerCase();
  return sender === "self" || sender === "sys" || sender === "system";
}

function isGroupMessage(raw, conversation, senderName) {
  if (typeof raw.is_group === "boolean") return raw.is_group;
  if (typeof raw.isGroup === "boolean") return raw.isGroup;
  return Boolean(conversation && senderName && conversation !== senderName);
}

export function mapToIntakePayload(raw, chatInfo) {
  if (isSelfOrSystemMessage(raw)) return null;

  const text = pickText(raw);
  const imageUrls = pickImageUrls(raw);
  if (!text && imageUrls.length === 0) return null;

  const conversation = pickConversation(raw, chatInfo);
  const { senderName, senderId } = pickSender(raw, chatInfo);
  const isGroup = isGroupMessage(raw, conversation, senderName);
  const stableSenderId = senderId || (!isGroup ? `wechat-direct:${conversation}` : undefined);
  const externalMessageId =
    normalizeString(raw.id || raw.msg_id || raw.msgId || raw.message_id) || messageFingerprint(raw, chatInfo);
  const receivedAt = normalizeString(raw.time || raw.timestamp || raw.createTime) || new Date().toISOString();

  return {
    channel: "wechat",
    externalMessageId,
    senderId: stableSenderId,
    senderName,
    senderGroup: isGroup ? conversation : undefined,
    sourceConversationId: conversation,
    text,
    imageUrls,
    receivedAt
  };
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`request failed: ${url} (${reason})`);
  } finally {
    clearTimeout(timeout);
  }
}

async function initializeWechat() {
  const url = `${config.wxautoBaseUrl}/v1/wechat/initialize`;
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.wxautoToken}`
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new Error(`wxauto initialize failed: ${body?.message ?? response.statusText}`);
  }
  console.log(`[wxauto] initialized: ${body?.message ?? "ok"}`);
}

async function initializeWechatWithRetry() {
  while (true) {
    try {
      await initializeWechat();
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[bridge] ${message}`);
      await sleep(Math.max(config.pollIntervalMs, 2000));
    }
  }
}

async function pullMessages() {
  const url = `${config.wxautoBaseUrl}/v1/wechat/getnextnewmessage`;
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.wxautoToken}`
    },
    body: JSON.stringify({
      filter_mute: config.filterMute,
      wxname: config.wxautoName
    })
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`wxauto pull failed: HTTP ${response.status}`);
  }
  if (!body?.success) {
    throw new Error(`wxauto pull failed: ${body?.message ?? "unknown error"}`);
  }

  const messages = Array.isArray(body?.data?.messages) ? body.data.messages : [];
  const chatInfo = body?.data?.chat_info && typeof body.data.chat_info === "object" ? body.data.chat_info : {};
  return { messages, chatInfo };
}

async function pushToIntake(payload) {
  if (config.dryRun) {
    console.log(`[dry-run] ${JSON.stringify(payload)}`);
    return;
  }

  const headers = {
    "Content-Type": "application/json"
  };
  if (config.intakeSecret) {
    headers["x-mcp-secret"] = config.intakeSecret;
  }

  const response = await fetchWithTimeout(config.intakeUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`intake push failed: HTTP ${response.status} ${body?.message ?? ""}`.trim());
  }
}

export function mapOutboundToWxautoSend(message) {
  return {
    who: message.targetName,
    msg: message.text,
    clear: true,
    exact: false
  };
}

export async function sendOutboundMessage({ message, fetchImpl = fetch, config: runtimeConfig = config }) {
  let status = "failed";
  let error;
  try {
    const sendResponse = await fetchImpl(`${runtimeConfig.wxautoBaseUrl}/v1/wechat/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runtimeConfig.wxautoToken}`
      },
      body: JSON.stringify(mapOutboundToWxautoSend(message))
    });
    const sendBody = await sendResponse.json().catch(() => ({}));
    status = sendResponse.ok && sendBody?.success !== false ? "sent" : "failed";
    error = status === "failed" ? sendBody?.message ?? `HTTP ${sendResponse.status}` : undefined;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const headers = {
    "Content-Type": "application/json"
  };
  if (runtimeConfig.intakeSecret) {
    headers["x-mcp-secret"] = runtimeConfig.intakeSecret;
  }
  await fetchImpl(`${runtimeConfig.outboundUrl}/${message.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(status === "sent" ? { status } : { status, error })
  });

  if (status === "failed") throw new Error(`outbound send failed: ${error}`);
}

export async function pullOutboundMessages(fetchImpl = fetch, runtimeConfig = config) {
  const headers = {
    "Content-Type": "application/json"
  };
  if (runtimeConfig.intakeSecret) {
    headers["x-mcp-secret"] = runtimeConfig.intakeSecret;
  }
  const response = await fetchImpl(runtimeConfig.outboundUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ limit: 10 })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`outbound claim failed: HTTP ${response.status}`);
  return Array.isArray(body.messages) ? body.messages : [];
}

async function processOutboundQueue() {
  const outboundMessages = await pullOutboundMessages(fetchWithTimeout);
  for (const message of outboundMessages) {
    if (config.dryRun) {
      console.log(`[dry-run-outbound] ${JSON.stringify(message)}`);
      continue;
    }
    try {
      await sendOutboundMessage({ message, fetchImpl: fetchWithTimeout });
      console.log(`[bridge] sent outbound ${message.id} (${message.targetName})`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`[bridge] outbound ${message.id} failed: ${reason}`);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  assertConfig();
  console.log(`[bridge] start, wxauto=${config.wxautoBaseUrl}, intake=${config.intakeUrl}, outbound=${config.outboundUrl}, dryRun=${config.dryRun}`);
  const dedupe = createDedupe(config.dedupeWindowSize);
  let lastOutboundPollAt = 0;

  await initializeWechatWithRetry();

  while (true) {
    try {
      const { messages, chatInfo } = await pullMessages();

      for (const raw of messages) {
        const payload = mapToIntakePayload(raw, chatInfo);
        if (!payload) continue;
        if (dedupe.has(payload.externalMessageId)) continue;

        await pushToIntake(payload);
        dedupe.add(payload.externalMessageId);
        console.log(`[bridge] forwarded ${payload.externalMessageId} (${payload.senderName})`);
      }

      if (Date.now() - lastOutboundPollAt >= config.outboundPollIntervalMs) {
        lastOutboundPollAt = Date.now();
        await processOutboundQueue();
      }

      if (messages.length === 0) {
        await sleep(config.pollIntervalMs);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[bridge] ${message}`);
      await sleep(Math.max(config.pollIntervalMs, 2000));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[bridge] fatal: ${message}`);
    process.exit(1);
  });
}
