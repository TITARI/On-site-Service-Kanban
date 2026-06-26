import type { TicketStatus } from "./types";

const transitions: Record<TicketStatus, TicketStatus[]> = {
  待受理: ["处理中"],
  处理中: ["挂起", "已解决"],
  挂起: ["处理中"],
  已解决: ["已关闭", "待再次处理"],
  待再次处理: ["处理中", "已解决", "挂起"],
  已关闭: []
};

export function canTransition(from: TicketStatus, to: TicketStatus) {
  return transitions[from]?.includes(to) ?? false;
}

export function createTicketTitle(boothNumber: string, companyShortName: string, issueType: string) {
  const safeCompany = companyShortName.trim() || "未知公司";
  return `${boothNumber.trim()} ${safeCompany} ${issueType.trim()}`;
}

export function elapsedSinceAccepted(acceptedAt: string | undefined, nowIso = new Date().toISOString()) {
  if (!acceptedAt) return 0;
  const elapsedMs = new Date(nowIso).getTime() - new Date(acceptedAt).getTime();
  return Math.max(0, Math.floor(elapsedMs / 60000));
}
