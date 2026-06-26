import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import type { PermissionCode } from "@/lib/domain/access-control";
import { canTransition } from "@/lib/domain/workflow";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { authErrorResponse, resolveRequestActor } from "@/lib/services/auth-service";

const statusSchema = z.object({
  action: z.enum(["status", "claim", "progress", "accept", "reject"]).default("status"),
  status: z.enum(["待受理", "处理中", "挂起", "已解决", "待再次处理", "已关闭"]),
  processBody: z.string().optional(),
  imageUrls: z.array(z.string()).default([]),
  reason: z.string().optional()
});

const ACTION_PERMISSION = {
  claim: "ticket.claim",
  progress: "ticket.process",
  accept: "ticket.accept",
  reject: "ticket.accept",
  status: "ticket.process"
} as const;

function hasPermission(actor: { permissions: PermissionCode[] }, action: keyof typeof ACTION_PERMISSION) {
  return actor.permissions.includes(ACTION_PERMISSION[action]);
}

function canActorProcessTicket(
  actor: { personId: string; groupName: string },
  ticket: { handlerId?: string; assignmentGroup?: string }
) {
  return ticket.handlerId === actor.personId || ticket.assignmentGroup === actor.groupName;
}

function canActorClaimTicket(actor: { groupName: string }, ticket: { handlerId?: string; assignmentGroup?: string }) {
  return !ticket.handlerId || ticket.assignmentGroup === actor.groupName;
}

export async function GET(request: Request, { params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await params;
  const repository = getAppRepository();
  try {
    await resolveRequestActor(repository, request, "mobile");
  } catch (error) {
    const response = authErrorResponse(error);
    return NextResponse.json({ message: response.message }, { status: response.status });
  }
  await repository.runAutoAcceptance();
  const ticket = await repository.getTicket(ticketId);
  if (!ticket) return NextResponse.json({ message: "工单不存在" }, { status: 404 });
  return NextResponse.json({ ticket });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await params;
  const repository = getAppRepository();
  let actor;
  try {
    actor = await resolveRequestActor(repository, request, "mobile");
  } catch (error) {
    const response = authErrorResponse(error);
    return NextResponse.json({ message: response.message }, { status: response.status });
  }

  let input: z.infer<typeof statusSchema>;
  try {
    const parsed = statusSchema.safeParse(await parseJson(request));
    if (!parsed.success) return badRequest("状态参数无效", parsed.error.flatten());
    input = parsed.data;
  } catch (error) {
    return badRequest(errorMessage(error));
  }
  if (input.action === "accept" && input.status !== "已关闭") {
    return badRequest("验收通过必须将状态置为已关闭");
  }
  if (input.action === "reject" && (!input.reason?.trim() || input.status !== "待再次处理")) {
    return badRequest("验收未通过必须填写原因并打回到待再次处理");
  }
  if (input.action === "progress" && (!input.processBody?.trim() || input.imageUrls.length === 0)) {
    return badRequest("处理进度必须填写处理内容并上传处理照片");
  }
  if (input.action === "status") {
    if (input.status === "已解决") {
      if (!input.processBody?.trim()) return badRequest("标记已解决必须填写处理内容");
      if (input.imageUrls.length === 0) return badRequest("标记已解决必须上传处理照片");
    }
    if (input.status === "挂起" && !input.reason?.trim()) return badRequest("挂起必须填写原因");
  }
  if (!hasPermission(actor, input.action)) return NextResponse.json({ message: "Forbidden" }, { status: 403 });

  const ticket = await repository.getTicket(ticketId);
  if (!ticket) return NextResponse.json({ message: "工单不存在" }, { status: 404 });
  if (input.action === "claim" && !canActorClaimTicket(actor, ticket)) {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 });
  }
  if ((input.action === "progress" || input.action === "status") && !canActorProcessTicket(actor, ticket)) {
    return NextResponse.json({ message: "Forbidden" }, { status: 403 });
  }
  if (!canTransition(ticket.status, input.status)) return NextResponse.json({ message: "状态流转不允许" }, { status: 400 });

  const now = new Date().toISOString();
  ticket.status = input.status;
  ticket.handlerId = input.action === "claim" ? actor.personId : ticket.handlerId;
  ticket.handlerName = input.action === "claim" ? actor.name : ticket.handlerName;
  ticket.handlerPhone = input.action === "claim" ? actor.phone : ticket.handlerPhone;
  ticket.assignmentGroup = input.action === "claim" ? actor.groupName : ticket.assignmentGroup;
  ticket.acceptedAt = input.status === "处理中" ? ticket.acceptedAt ?? now : ticket.acceptedAt;
  ticket.updatedAt = now;

  let notificationText: string | undefined;

  if (input.action === "claim") {
    ticket.timeline.push({
      id: crypto.randomUUID(),
      ticketId,
      type: "status-changed",
      body: `${actor.name}认领工单`,
      createdAt: now,
      actorName: actor.name
    });
  } else if (input.action === "progress") {
    ticket.replies.push({
      id: crypto.randomUUID(),
      ticketId,
      authorId: actor.personId,
      authorName: actor.name,
      authorPhone: actor.phone,
      role: "handler",
      body: input.processBody?.trim() ?? "",
      imageUrls: input.imageUrls,
      createdAt: now
    });
    ticket.timeline.push({
      id: crypto.randomUUID(),
      ticketId,
      type: "status-changed",
      body: `状态变更为${input.status}：${input.processBody}`,
      createdAt: now,
      actorName: actor.name
    });
    if (input.status === "已解决") {
      notificationText = `工单已解决：${ticket.title}\n处理说明：${input.processBody?.trim()}`;
    }
  } else if (input.action === "accept") {
    ticket.timeline.push({
      id: crypto.randomUUID(),
      ticketId,
      type: "receipt",
      body: `${actor.groupName}验收通过，工单闭环`,
      createdAt: now,
      actorName: actor.name
    });
    if (input.status === "已关闭") {
      notificationText = `工单已关闭：${ticket.title}\n感谢反馈，处理已闭环。`;
    }
  } else if (input.action === "reject") {
    ticket.timeline.push({
      id: crypto.randomUUID(),
      ticketId,
      type: "receipt",
      body: `${actor.groupName}验收未通过：${input.reason?.trim()}`,
      createdAt: now,
      actorName: actor.name
    });
    notificationText = `工单验收未通过，已退回处理：${ticket.title}\n原因：${input.reason?.trim()}`;
  } else {
    ticket.timeline.push({
      id: crypto.randomUUID(),
      ticketId,
      type: "status-changed",
      body: input.status === "挂起" ? `状态变更为挂起：${input.reason}` : `状态变更为${input.status}`,
      createdAt: now,
      actorName: actor.name
    });
  }

  await repository.saveTicket(ticket, { notificationText });
  return NextResponse.json({ ticket });
}
