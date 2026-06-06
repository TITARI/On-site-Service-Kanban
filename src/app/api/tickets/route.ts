import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";

const submitSchema = z.object({
  boothNumber: z.string().min(1),
  description: z.string().min(2),
  imageUrls: z.array(z.string()).default([]),
  issueType: z.string().min(1),
  submitterId: z.string().min(1),
  submitterName: z.string().min(1),
  submitterPhone: z.string().default("")
});

export async function GET() {
  const repository = getAppRepository();
  await repository.runAutoAcceptance();
  const tickets = await repository.listTicketSummaries();
  return NextResponse.json({ tickets });
}

export async function POST(request: Request) {
  let input: z.infer<typeof submitSchema>;
  try {
    const parsed = submitSchema.safeParse(await parseJson(request));
    if (!parsed.success) return badRequest("工单参数无效", parsed.error.flatten());
    input = parsed.data;
  } catch (error) {
    return badRequest(errorMessage(error));
  }

  const result = await getAppRepository().submitTicket(input);
  return NextResponse.json(result);
}
