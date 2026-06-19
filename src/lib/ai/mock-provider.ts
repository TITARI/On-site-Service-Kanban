import type { Ticket } from "../domain/types";
import { decideDeduplication } from "../domain/deduplication";
import type { AiProvider } from "./types";

function detectIssueType(description: string) {
  if (/网络|扫码|没网|wifi|Wi-Fi/i.test(description)) return "网络";
  if (/缃戠粶|鎵爜|娌＄綉/i.test(description)) return "缃戠粶";
  if (/电|插座|跳闸|照明/.test(description)) return "电力";
  if (/鐢祙鎻掑骇|璺抽椄|鐓ф槑/.test(description)) return "鐢靛姏";
  if (/搭建|展架|板墙|施工/.test(description)) return "搭建";
  if (/鎼缓|灞曟灦|鏉垮|鏂藉伐/.test(description)) return "鎼缓";
  return "综合服务";
}

function hasSharedOperationalIntent(a: string, b: string) {
  const keywords = ["网络", "扫码", "断", "失败", "无法", "电", "搭建"];
  const shared = keywords.filter((keyword) => a.includes(keyword) && b.includes(keyword));
  return shared.length >= 2;
}

function similarity(a: string, b: string) {
  if (hasSharedOperationalIntent(a, b)) return 0.91;

  const left = new Set(a.replace(/\s+/g, "").split(""));
  const right = new Set(b.replace(/\s+/g, "").split(""));
  const overlap = Array.from(left).filter((char) => right.has(char)).length;
  return overlap / Math.max(1, Math.min(left.size, right.size));
}

function bestCandidate(description: string, candidates: Ticket[]) {
  return candidates
    .map((ticket) => ({ ticket, score: similarity(description, ticket.description) }))
    .sort((a, b) => b.score - a.score)[0];
}

export const mockAiProvider: AiProvider = {
  async classify(model, boothNumber, description) {
    return {
      modelId: model.id,
      scenario: "classify",
      confidence: 0.86,
      action: "classify",
      issueType: detectIssueType(description),
      latencyMs: model.id === "fast" ? 120 : 380
    };
  },
  async dedupe(model, boothNumber, description, candidates) {
    const sameBooth = candidates.filter((ticket) => ticket.boothNumber === boothNumber);
    const best = bestCandidate(description, sameBooth);
    const confidence = best?.score ?? 0;

    return {
      modelId: model.id,
      scenario: "dedupe",
      confidence,
      action: decideDeduplication(confidence),
      matchedTicketId: best?.ticket.id,
      latencyMs: model.id === "fast" ? 150 : 420
    };
  },
  async escalate(model, boothNumber, description, similarTickets) {
    return {
      modelId: model.id,
      scenario: "escalation",
      confidence: 0.81,
      action: "manual-review",
      suggestion: `展位${boothNumber}已超时，优先核查责任人响应、历史相似工单和现场资源占用。`,
      matchedTicketId: similarTickets[0]?.id,
      latencyMs: 520
    };
  },
  async customerService(model, context) {
    const text = context.messageText;
    const ticket = context.candidateTickets[0];
    const highPressure = /催|加急|尽快|投诉|着急|急/i.test(text);
    return {
      modelId: "smart",
      scenario: "customer-service",
      confidence: highPressure && ticket ? 0.9 : 0.45,
      pressureLevel: highPressure ? 4 : 2,
      action: highPressure && ticket ? "expedite" : "ask-follow-up",
      matchedTicketId: ticket?.id,
      replyText: ticket
        ? `收到，我已帮您加急并同步催办处理组。当前进度：${ticket.status}，我们会继续跟进现场处理结果。`
        : "收到，我来帮您跟进。请补充展位号或对应问题，我确认到具体工单后马上帮您催办。",
      reason: highPressure ? "用户表达客户持续催促，建议加急处理。" : "信息不足，需要补充后再处理。",
      latencyMs: model.id === "smart" ? 480 : 180
    };
  },
  async mapExhibitorFields() {
    return { mappings: [] };
  }
};
