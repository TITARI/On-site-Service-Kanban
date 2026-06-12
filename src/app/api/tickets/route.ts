import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { requireRequestActor } from "@/lib/services/auth-service";

const submitSchema = z.object({
  boothNumber: z.string().min(1),
  description: z.string().min(2),
  imageUrls: z.array(z.string()).default([]),
  issueType: z.string().min(1)
});

export async function GET(request: Request) {
  const auth = await requireRequestActor(request, "mobile", undefined);
  if (!auth.ok) return auth.response;
  const repository = getAppRepository();
  await repository.runAutoAcceptance();
  const tickets = await repository.listTicketSummaries();
  return NextResponse.json({ tickets });
}

export async function POST(request: Request) {
  const auth = await requireRequestActor(request, "mobile", undefined);
  if (!auth.ok) return auth.response;
  let input: z.infer<typeof submitSchema>;
  try {
    const parsed = submitSchema.safeParse(await parseJson(request));
    if (!parsed.success) return badRequest("工单参数无效", parsed.error.flatten());
    input = parsed.data;
  } catch (error) {
    return badRequest(errorMessage(error));
  }

  const result = await getAppRepository().submitTicket({
    ...input,
    submitterId: auth.actor.personId,
    submitterName: auth.actor.name,
    submitterPhone: auth.actor.phone,
    reporterPersonId: auth.actor.personId
  });
  return NextResponse.json(result);
}
