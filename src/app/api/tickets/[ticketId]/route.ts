import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import { canTransition } from "@/lib/domain/workflow";
import { getAppRepository } from "@/lib/repositories/app-repository";
import type { PermissionCode } from "@/lib/domain/access-control";
import { requireRequestActor } from "@/lib/services/auth-service";

const statusSchema = z.object({
  action: z.enum(["status", "claim", "progress", "accept", "reject"]).default("status"),
  status: z.enum(["待受理", "处理中", "挂起", "已解决", "待再次处理", "已关闭"]),
  processBody: z.string().optional(),
  imageUrls: z.array(z.string()).default([]),
  reason: z.string().optional()
});

const ACTION_PERMISSION: Record<z.infer<typeof statusSchema>["action"], PermissionCode> = {
  claim: "ticket.claim",
  progress: "ticket.process",
  accept: "ticket.accept",
  reject: "ticket.accept",
  status: "ticket.process"
};

export async function GET(request: Request, { params }: { params: Promise<{ ticketId: string }> }) {
  const auth = await requireRequestActor(request, "mobile", undefined);
  if (!auth.ok) return auth.response;
  const { ticketId } = await params;
  const repository = getAppRepository();
  await repository.runAutoAcceptance();
  const ticket = await repository.getTicket(ticketId);
  if (!ticket) return NextResponse.json({ message: "工单不存在" }, { status: 404 });
  return NextResponse.json({ ticket });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await params;
  let input: z.infer<typeof statusSchema>;
  try {
    const parsed = statusSchema.safeParse(await parseJson(request));
    if (!parsed.success) return badRequest("状态参数无效", parsed.error.flatten());
    input = parsed.data;
  } catch (error) {
    return badRequest(errorMessage(error));
  }
  const auth = await requireRequestActor(request, "mobile", ACTION_PERMISSION[input.action]);
  if (!auth.ok) return auth.response;
  if (input.status === "挂起" && !input.reason?.trim() && input.action === "status") return badRequest("挂起必须填写原因");
  if (input.action === "reject" && (!input.reason?.trim() || input.status !== "待再次处理")) {
    return badRequest("验收未通过必须填写原因并打回到待再次处理");
  }
  if (input.action === "progress" && (!input.processBody?.trim() || input.imageUrls.length === 0)) {
    return badRequest("处理进度必须填写处理内容并上传处理照片");
  }

  const repository = getAppRepository();
  const ticket = await repository.getTicket(ticketId);
  if (!ticket) return NextResponse.json({ message: "工单不存在" }, { status: 404 });
  if (!canTransition(ticket.status, input.status)) return NextResponse.json({ message: "状态流转不允许" }, { status: 400 });
  if (
    input.action === "claim"
    && ticket.assignmentGroup
    && ticket.assignmentGroup !== auth.actor.groupName
  ) {
    return NextResponse.json({ message: "该工单不属于当前分组" }, { status: 403 });
  }
  if (
    (input.action === "progress" || input.action === "status")
    && ticket.handlerId !== auth.actor.personId
    && ticket.assignmentGroup !== auth.actor.groupName
  ) {
    return NextResponse.json({ message: "仅处理人或指派分组可更新工单" }, { status: 403 });
  }

  const now = new Date().toISOString();
  ticket.status = input.status;
  if (input.action === "claim") {
    ticket.handlerId = auth.actor.personId;
    ticket.handlerName = auth.actor.name;
    ticket.handlerPhone = auth.actor.phone;
    ticket.assignmentGroup = auth.actor.groupName;
  }
  ticket.acceptedAt = input.status === "处理中" ? ticket.acceptedAt ?? now : ticket.acceptedAt;
  ticket.updatedAt = now;

  let notificationText: string | undefined;

  if (input.action === "claim") {
    ticket.timeline.push({
      id: crypto.randomUUID(),
      ticketId,
      type: "status-changed",
      body: `${auth.actor.name}认领工单`,
      createdAt: now,
      actorName: auth.actor.name
    });
  } else if (input.action === "progress") {
    ticket.replies.push({
      id: crypto.randomUUID(),
      ticketId,
      authorId: auth.actor.personId,
      authorName: auth.actor.name,
      authorPhone: auth.actor.phone,
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
      actorName: auth.actor.name
    });
    if (input.status === "已解决") {
      notificationText = `工单已解决：${ticket.title}\n处理说明：${input.processBody?.trim()}`;
    }
  } else if (input.action === "accept") {
    ticket.timeline.push({
      id: crypto.randomUUID(),
      ticketId,
      type: "receipt",
      body: `${auth.actor.groupName}验收通过，工单闭环`,
      createdAt: now,
      actorName: auth.actor.name
    });
    if (input.status === "已关闭") {
      notificationText = `工单已关闭：${ticket.title}\n感谢反馈，处理已闭环。`;
    }
  } else if (input.action === "reject") {
    ticket.timeline.push({
      id: crypto.randomUUID(),
      ticketId,
      type: "receipt",
      body: `${auth.actor.groupName}验收未通过：${input.reason?.trim()}`,
      createdAt: now,
      actorName: auth.actor.name
    });
    notificationText = `工单验收未通过，已退回处理：${ticket.title}\n原因：${input.reason?.trim()}`;
  } else {
    ticket.timeline.push({
      id: crypto.randomUUID(),
      ticketId,
      type: "status-changed",
      body: input.status === "挂起" ? `状态变更为挂起：${input.reason}` : `状态变更为${input.status}`,
      createdAt: now,
      actorName: auth.actor.name
    });
  }

  await repository.saveTicket(ticket, { notificationText });
  return NextResponse.json({ ticket });
}
