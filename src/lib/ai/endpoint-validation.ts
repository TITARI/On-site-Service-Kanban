import { isIP } from "node:net";

const BLOCKED_CIDRS = [
  { ip: "127.0.0.0", prefix: 8 },
  { ip: "10.0.0.0", prefix: 8 },
  { ip: "172.16.0.0", prefix: 12 },
  { ip: "192.168.0.0", prefix: 16 },
  { ip: "169.254.0.0", prefix: 16 },
  { ip: "0.0.0.0", prefix: 8 },
  { ip: "100.64.0.0", prefix: 10 }
];

const ALLOWED_API_KEY_ENVS = new Set([
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "DASHSCOPE_API_KEY",
  "MOONSHOT_API_KEY",
  "ZHIPU_API_KEY",
  "ARK_API_KEY",
  "AI_FAST_API_KEY",
  "AI_SMART_API_KEY"
]);

function ipToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number.parseInt(octet, 10), 0) >>> 0;
}

function isIpInCidr(ip: string, cidrIp: string, prefix: number): boolean {
  if (isIP(ip) !== 4) return false;
  const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(cidrIp) & mask);
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost") return true;
  const ipVersion = isIP(host);
  if (
    ipVersion === 6 &&
    (host === "::1" ||
      host === "::" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe80") ||
      host.startsWith("::ffff:"))
  ) {
    return true;
  }
  if (ipVersion === 4) {
    return BLOCKED_CIDRS.some((cidr) => isIpInCidr(host, cidr.ip, cidr.prefix));
  }
  return false;
}

export function validateAiEndpoint(endpoint: string): { ok: true } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, reason: "无效的 URL" };
  }

  if (url.protocol !== "https:") {
    return { ok: false, reason: "AI endpoint 仅允许 HTTPS" };
  }
  if (isBlockedHost(url.hostname)) {
    return { ok: false, reason: "AI endpoint 不允许访问内网/本地/链路本地地址" };
  }
  return { ok: true };
}

export function validateApiKeyEnv(envName: string | undefined): boolean {
  if (!envName) return true;
  return ALLOWED_API_KEY_ENVS.has(envName);
}

export function assertApiKeyEnv(envName: string | undefined): void {
  if (!validateApiKeyEnv(envName)) {
    throw new Error(`apiKeyEnv "${envName}" 不在白名单中`);
  }
}
