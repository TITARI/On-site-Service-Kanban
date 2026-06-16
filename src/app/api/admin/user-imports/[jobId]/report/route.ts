import * as XLSX from "xlsx";
import { badRequest, errorMessage } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { createUserImportService } from "@/lib/services/user-import-service";
import { adminActorOrResponse } from "../../../users/route-utils";

type RouteContext = {
  params: Promise<{ jobId: string }>;
};

async function jobIdFrom(context: RouteContext) {
  return (await context.params).jobId;
}

export async function GET(request: Request, context: RouteContext) {
  const auth = await adminActorOrResponse(request);
  if ("response" in auth) return auth.response;

  try {
    const jobId = await jobIdFrom(context);
    const reportRows = await createUserImportService(
      getAppRepository()
    ).report(jobId, auth.actor);
    const sheet = XLSX.utils.json_to_sheet(reportRows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "用户导入结果");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    return new Response(bytes, { headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="user-import-${jobId}.xlsx"`
    }});
  } catch (error) {
    return badRequest(errorMessage(error));
  }
}
