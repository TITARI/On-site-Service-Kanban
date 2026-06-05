import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";

const replySchema = z.object({
  authorId: z.string().min(1),
  authorName: z.string().min(1),
  authorPhone: z.string().optional(),
  role: z.enum(["member", "admin", "handler", "system-ai"]),
  body: z.string().min(1),
  imageUrls: z.array(z.string()).default([])
});

export async function POST(request: Request, { params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await params;
  let input: z.infer<typeof replySchema>;
  try {
    const parsed = replySchema.safeParse(await parseJson(request));
    if (!parsed.success) return badRequest("回复参数无效", parsed.error.flatten());
    input = parsed.data;
  } catch (error) {
    return badRequest(errorMessage(error));
  }

  const repository = getAppRepository();
  const ticket = await repository.getTicket(ticketId);
  if (!ticket) return NextResponse.json({ message: "工单不存在" }, { status: 404 });

  const now = new Date().toISOString();
  const reply = { id: crypto.randomUUID(), ticketId, createdAt: now, ...input };
  ticket.replies.push(reply);
  ticket.timeline.push({ id: crypto.randomUUID(), ticketId, type: "reply", body: input.body, createdAt: now, actorName: input.authorName });
  ticket.updatedAt = now;
  await repository.saveTicket(ticket);
  return NextResponse.json({ reply, ticket });
}
