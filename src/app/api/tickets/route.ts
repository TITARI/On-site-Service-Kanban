import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { authErrorResponse, resolveRequestActor } from "@/lib/services/auth-service";

const submitSchema = z.object({
  boothNumber: z.string().min(1),
  description: z.string().min(2),
  imageUrls: z.array(z.string()).default([]),
  issueType: z.string().min(1)
});

export async function GET(request: Request) {
  const repository = getAppRepository();
  try {
    await resolveRequestActor(repository, request, "mobile");
  } catch (error) {
    const response = authErrorResponse(error);
    return NextResponse.json({ message: response.message }, { status: response.status });
  }
  await repository.runAutoAcceptance();
  const tickets = await repository.listTicketSummaries();
  return NextResponse.json({ tickets });
}

export async function POST(request: Request) {
  const repository = getAppRepository();
  let actor;
  try {
    actor = await resolveRequestActor(repository, request, "mobile");
  } catch (error) {
    const response = authErrorResponse(error);
    return NextResponse.json({ message: response.message }, { status: response.status });
  }

  let input: z.infer<typeof submitSchema>;
  try {
    const parsed = submitSchema.safeParse(await parseJson(request));
    if (!parsed.success) return badRequest("工单参数无效", parsed.error.flatten());
    input = parsed.data;
  } catch (error) {
    return badRequest(errorMessage(error));
  }

  const result = await repository.submitTicket({
    ...input,
    submitterId: actor.personId,
    submitterName: actor.name,
    submitterPhone: actor.phone
  });
  return NextResponse.json(result);
}
