import * as XLSX from "xlsx";
import { NextResponse } from "next/server";
import { errorMessage } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { requireRequestActor } from "@/lib/services/auth-service";
import {
  getUserImportJob,
  userImportErrorStatus
} from "@/lib/services/user-import-service";

type Context = { params: Promise<{ jobId: string }> };

export async function GET(request: Request, { params }: Context) {
  const auth = await requireRequestActor(request, "admin", "admin.access");
  if (!auth.ok) return auth.response;
  const { jobId } = await params;
  try {
    const job = await getUserImportJob(getAppRepository(), jobId, auth.actor);
    const reportRows = job.rows.map((row) => ({
      行号: row.rowNumber,
      姓名: row.normalized.name,
      手机号: row.normalized.phone,
      分组: row.normalized.groupId,
      分组锁定: row.normalized.groupLocked ? "是" : "否",
      启用状态: row.normalized.enabled ? "启用" : "停用",
      微信账号标识: row.normalized.wechatExternalUserId ?? "",
      企微账号标识: row.normalized.wecomExternalUserId ?? "",
      决策: row.decision?.action ?? "",
      结果: row.resultAction ?? (row.errors.length > 0 ? "不可导入" : "待处理"),
      说明: row.resultMessage ?? [...row.errors, ...row.conflicts].join("、")
    }));
    const sheet = XLSX.utils.json_to_sheet(reportRows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "用户导入结果");
    const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    return new Response(bytes, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="user-import-${jobId}.xlsx"`
      }
    });
  } catch (error) {
    return NextResponse.json(
      { message: errorMessage(error) },
      { status: userImportErrorStatus(error) }
    );
  }
}
