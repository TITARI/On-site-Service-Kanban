import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as XLSX from "xlsx";
import { AdminUserImport } from "@/components/admin-user-import";
import type { UserImportJob } from "@/lib/domain/user-import";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function previewJob(): UserImportJob {
  return {
    id: "import-job-1",
    type: "people",
    ownerAccountId: "account-admin",
    sourceName: "users.xlsx",
    sourceHash: "a".repeat(64),
    previewVersion: "preview-1",
    status: "preview",
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
    rows: [{
      id: "row-1",
      rowNumber: 2,
      raw: {},
      normalized: {
        name: "张三",
        phone: "13800138000",
        groupId: "builder",
        groupLocked: true,
        enabled: true,
        wechatExternalUserId: "wxid-occupied",
        wecomExternalUserId: "wecom-zhang"
      },
      errors: [],
      conflicts: ["wechat-occupied"],
      allowedActions: ["add", "skip"]
    }]
  };
}

describe("AdminUserImport", () => {
  it("previews the seven-column template, confirms rebinds, and commits the job", async () => {
    const job = previewJob();
    const completed: UserImportJob = {
      ...job,
      status: "completed",
      completedAt: "2026-06-12T01:00:00.000Z",
      rows: [{
        ...job.rows[0],
        decision: {
          action: "add",
          confirmWechatRebind: true,
          confirmWecomRebind: false
        },
        resultAction: "add",
        resultMessage: "新增成功"
      }]
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/user-imports/preview") {
        return new Response(JSON.stringify(job), { status: 201 });
      }
      if (url === "/api/admin/user-imports/import-job-1/rows" && init?.method === "PATCH") {
        return new Response(JSON.stringify(job), { status: 200 });
      }
      if (url === "/api/admin/user-imports/import-job-1/commit" && init?.method === "POST") {
        return new Response(JSON.stringify(completed), { status: 200 });
      }
      return new Response(JSON.stringify({ message: "unexpected request" }), { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("crypto", webcrypto);
    const onCompleted = vi.fn();
    const user = userEvent.setup();
    render(<AdminUserImport onClose={vi.fn()} onCompleted={onCompleted} />);

    expect(screen.getByRole("button", { name: "下载模板" })).not.toBeNull();
    expect(screen.getByText(/微信账号标识、企微账号标识/)).not.toBeNull();

    const sheet = XLSX.utils.aoa_to_sheet([
      ["姓名", "手机号", "分组", "分组锁定", "启用状态", "微信账号标识", "企微账号标识"],
      ["张三", "13800138000", "搭建组", "是", "启用", "wxid-occupied", "wecom-zhang"]
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "用户");
    const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const file = new File([bytes], "users.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
    Object.defineProperty(file, "arrayBuffer", {
      value: vi.fn(async () => bytes)
    });

    await user.upload(screen.getByLabelText("选择用户导入文件"), file);
    await user.click(screen.getByRole("button", { name: "生成预览" }));

    expect(await screen.findByText("张三")).not.toBeNull();
    await user.click(screen.getByLabelText("确认微信换绑"));
    await user.click(screen.getByRole("button", { name: "提交导入" }));

    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("heading", { name: "用户导入完成" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "下载导入报告" }).getAttribute("href"))
      .toBe("/api/admin/user-imports/import-job-1/report");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/user-imports/import-job-1/rows",
      expect.objectContaining({
        body: expect.stringContaining("\"confirmWechatRebind\":true")
      })
    );
  });
});
