import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminUsersPanel } from "@/components/admin-users-panel";
import type { UserGroup } from "@/lib/domain/types";
import { queryKeys } from "@/lib/client/query-keys";
import { renderWithQueryClient } from "../helpers/query-client";

const groups: UserGroup[] = [
  {
    id: "builder",
    name: "Builder",
    description: "Builder group",
    canClaim: true,
    canProcess: false,
    canAccept: false,
    canAdmin: false,
    enabled: true
  }
];

vi.mock("xlsx", () => ({
  read: vi.fn(() => ({ SheetNames: ["Sheet1"], Sheets: { Sheet1: {} } })),
  utils: {
    sheet_to_json: vi.fn(() => [{
      濮撳悕: "寮犱笁",
      鎵嬫満鍙: "13800138000",
      鍒嗙粍: "Builder"
    }])
  }
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AdminUserImport", () => {
  it("parses a file, previews decisions, commits, refreshes users, and downloads the report", async () => {
    const reportBlob = new Blob(["report"], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/users?page=1&pageSize=20") {
        return new Response(JSON.stringify({ users: [], total: 0 }), { status: 200 });
      }
      if (url === "/api/admin/user-imports/preview" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body.sourceName).toBe("users.csv");
        expect(body.sourceHash).toMatch(/^[a-f0-9]{64}$/);
        return new Response(JSON.stringify({
          jobId: "import-job-1",
          previewVersion: "preview-1",
          sourceName: "users.csv",
          sourceHash: body.sourceHash,
          rows: [
            {
              id: "row-1",
              rowNumber: 1,
              raw: { 濮撳悕: "寮犱笁" },
              value: {
                name: "寮犱笁",
                phone: "13800138000",
                groupId: "builder",
                groupLocked: false,
                enabled: true,
                wechatExternalUserId: "wxid-occupied"
              },
              conflicts: ["wechat-occupied"],
              allowedActions: ["add", "skip"],
              category: "add",
              selectable: true
            }
          ],
          summary: { total: 1, selectable: 1, blocked: 0 }
        }), { status: 201 });
      }
      if (url === "/api/admin/user-imports/import-job-1/rows" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        expect(body.decisions).toEqual([{
          rowId: "row-1",
          decision: {
            action: "add",
            confirmWechatRebind: true,
            confirmWecomRebind: false
          }
        }]);
        return new Response(null, { status: 204 });
      }
      if (url === "/api/admin/user-imports/import-job-1/commit" && init?.method === "POST") {
        return new Response(JSON.stringify({ committed: 1 }), { status: 200 });
      }
      if (url === "/api/admin/user-imports/import-job-1/report") {
        return new Response(reportBlob, { status: 200 });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const createdUrls: string[] = [];
    const revokedUrls: string[] = [];
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => {
        const url = `blob:report-${createdUrls.length + 1}`;
        createdUrls.push(url);
        return url;
      }),
      revokeObjectURL: vi.fn((url: string) => revokedUrls.push(url))
    });
    const clickMock = vi.fn();
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      const element = originalCreateElement(tagName);
      if (tagName.toLowerCase() === "a") {
        vi.spyOn(element, "click").mockImplementation(clickMock);
      }
      return element;
    });
    const userDriver = userEvent.setup();

    const { queryClient } = renderWithQueryClient(<AdminUsersPanel groups={groups} />);
    queryClient.setQueryData(queryKeys.admin.bootstrap, { config: {} });

    await userDriver.click(await screen.findByRole("button", { name: "批量导入" }));
    const importDialog = await screen.findByRole("dialog", { name: "批量导入用户" });
    expect(within(importDialog).getByText("选择文件")).not.toBeNull();
    expect(within(importDialog).getByText("处理冲突")).not.toBeNull();
    expect(within(importDialog).getByText("导入结果")).not.toBeNull();

    const file = new File(["name,phone\nzhang,13800138000"], "users.csv", {
      type: "text/csv"
    });
    await userDriver.upload(
      within(importDialog).getByLabelText("选择用户导入文件"),
      file
    );
    await userDriver.click(within(importDialog).getByRole("button", { name: "生成预览" }));

    expect(await within(importDialog).findByText("寮犱笁")).not.toBeNull();
    expect(within(importDialog).getByText("共 1 行")).not.toBeNull();
    expect(within(importDialog).getByText("0 行不可导入")).not.toBeNull();
    await userDriver.click(within(importDialog).getByLabelText("确认微信换绑"));
    await userDriver.click(within(importDialog).getByRole("button", { name: "提交导入" }));

    await waitFor(() => expect(queryClient.getQueryState(queryKeys.admin.bootstrap)?.isInvalidated).toBe(true));
    expect(await within(importDialog).findByText("用户导入完成")).not.toBeNull();
    await userDriver.click(within(importDialog).getByRole("button", { name: "下载导入报告" }));

    expect(clickMock).toHaveBeenCalled();
    expect(createdUrls).toEqual(["blob:report-1"]);
    expect(revokedUrls).toEqual(["blob:report-1"]);
  });

  it("applies bulk add, overwrite, and skip decisions to selectable rows", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/users?page=1&pageSize=20") {
        return new Response(JSON.stringify({ users: [], total: 0 }), { status: 200 });
      }
      if (url === "/api/admin/user-imports/preview" && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return new Response(JSON.stringify({
          jobId: "import-job-2",
          previewVersion: "preview-2",
          sourceName: "users.csv",
          sourceHash: body.sourceHash,
          rows: [
            {
              id: "row-add",
              rowNumber: 1,
              raw: { 濮撳悕: "Add User" },
              value: {
                name: "Add User",
                phone: "13800138001",
                groupId: "builder",
                groupLocked: false,
                enabled: true
              },
              conflicts: [],
              allowedActions: ["add", "skip"],
              category: "add",
              selectable: true
            },
            {
              id: "row-overwrite",
              rowNumber: 2,
              raw: { 濮撳悕: "Overwrite User" },
              value: {
                name: "Overwrite User",
                phone: "13800138002",
                groupId: "builder",
                groupLocked: false,
                enabled: true
              },
              conflicts: ["phone-occupied"],
              allowedActions: ["overwrite", "skip"],
              category: "overwrite",
              selectable: true
            }
          ],
          summary: { total: 2, selectable: 2, blocked: 0 }
        }), { status: 201 });
      }
      if (url === "/api/admin/user-imports/import-job-2/rows" && init?.method === "PATCH") {
        return new Response(null, { status: 204 });
      }
      if (url === "/api/admin/user-imports/import-job-2/commit" && init?.method === "POST") {
        return new Response(JSON.stringify({ committed: 0 }), { status: 200 });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const userDriver = userEvent.setup();

    renderWithQueryClient(<AdminUsersPanel groups={groups} />);

    await userDriver.click(await screen.findByRole("button", { name: "批量导入" }));
    const importDialog = await screen.findByRole("dialog", { name: "批量导入用户" });
    await userDriver.upload(
      within(importDialog).getByLabelText("选择用户导入文件"),
      new File(["name,phone"], "users.csv", { type: "text/csv" })
    );
    await userDriver.click(within(importDialog).getByRole("button", { name: "生成预览" }));

    await within(importDialog).findByText("Add User");
    const rowOneDecision = within(importDialog).getByLabelText("第 1 行操作");
    const rowTwoDecision = within(importDialog).getByLabelText("第 2 行操作");
    await userDriver.click(within(importDialog).getByRole("button", { name: "全部跳过" }));

    expect(rowOneDecision).toHaveProperty("value", "skip");
    expect(rowTwoDecision).toHaveProperty("value", "skip");

    await userDriver.click(within(importDialog).getByRole("button", { name: "可新增项设为新增" }));

    expect(rowOneDecision).toHaveProperty("value", "add");
    expect(rowTwoDecision).toHaveProperty("value", "skip");

    await userDriver.click(within(importDialog).getByRole("button", { name: "可覆盖项设为覆盖" }));

    expect(rowOneDecision).toHaveProperty("value", "skip");
    expect(rowTwoDecision).toHaveProperty("value", "overwrite");
  });
});
