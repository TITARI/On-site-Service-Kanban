import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { authErrorResponse, resolveRequestActor } from "@/lib/services/auth-service";

const replySchema = z.object({
  body: z.string().min(1),
  imageUrls: z.array(z.string()).default([])
});

export async function POST(request: Request, { params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await params;
  const repository = getAppRepository();
  let actor;
  try {
    actor = await resolveRequestActor(repository, request, "mobile");
  } catch (error) {
    const response = authErrorResponse(error);
    return NextResponse.json({ message: response.message }, { status: response.status });
  }

  let input: z.infer<typeof replySchema>;
  try {
    const parsed = replySchema.safeParse(await parseJson(request));
    if (!parsed.success) return badRequest("回复参数无效", parsed.error.flatten());
    input = parsed.data;
  } catch (error) {
    return badRequest(errorMessage(error));
  }

  const ticket = await repository.getTicket(ticketId);
  if (!ticket) return NextResponse.json({ message: "工单不存在" }, { status: 404 });

  const now = new Date().toISOString();
  const reply = {
    id: crypto.randomUUID(),
    ticketId,
    authorId: actor.personId,
    authorName: actor.name,
    authorPhone: actor.phone,
    role: "member" as const,
    body: input.body,
    imageUrls: input.imageUrls,
    createdAt: now
  };
  ticket.replies.push(reply);
  ticket.timeline.push({ id: crypto.randomUUID(), ticketId, type: "reply", body: input.body, createdAt: now, actorName: actor.name });
  ticket.updatedAt = now;
  await repository.saveTicket(ticket);
  return NextResponse.json({ reply, ticket });
}
