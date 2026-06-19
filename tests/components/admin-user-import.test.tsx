import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminUsersPanel } from "@/components/admin-users-panel";
import type { UserGroup } from "@/lib/domain/types";

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
    const onRefresh = vi.fn();
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

    render(<AdminUsersPanel groups={groups} onRefresh={onRefresh} />);

    const importRegion = await screen.findByRole("region", { name: "用户导入" });
    expect(within(importRegion).getByText("1. 选择文件")).not.toBeNull();
    expect(within(importRegion).getByText("2. 处理冲突")).not.toBeNull();
    expect(within(importRegion).getByText("3. 提交并下载报告")).not.toBeNull();

    const file = new File(["name,phone\nzhang,13800138000"], "users.csv", {
      type: "text/csv"
    });
    await userDriver.upload(
      within(importRegion).getByLabelText("导入文件"),
      file
    );
    await userDriver.click(within(importRegion).getByRole("button", { name: "解析并预览" }));

    expect(await within(importRegion).findByText("寮犱笁")).not.toBeNull();
    expect(within(importRegion).getByText("需处理 1 行，可导入 1 行，阻塞 0 行")).not.toBeNull();
    await userDriver.click(within(importRegion).getByLabelText("确认换绑微信身份"));
    await userDriver.click(within(importRegion).getByRole("button", { name: "提交导入" }));

    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    await userDriver.click(within(importRegion).getByRole("button", { name: "下载导入报告" }));

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

    render(<AdminUsersPanel groups={groups} />);

    const importRegion = await screen.findByRole("region", { name: /导入|瀵煎叆/ });
    await userDriver.upload(
      within(importRegion).getByLabelText(/导入文件|瀵煎叆/),
      new File(["name,phone"], "users.csv", { type: "text/csv" })
    );
    await userDriver.click(within(importRegion).getByRole("button", { name: /预览|瑙ｆ瀽/ }));

    await within(importRegion).findByText("Add User");
    const rowOneDecision = within(importRegion).getByLabelText(/1.*处理方式|1.*澶勭悊/);
    const rowTwoDecision = within(importRegion).getByLabelText(/2.*处理方式|2.*澶勭悊/);
    await userDriver.selectOptions(within(importRegion).getByLabelText("批量处理方式"), "skip");
    await userDriver.click(within(importRegion).getByRole("button", { name: "应用批量处理" }));

    expect(rowOneDecision).toHaveProperty("value", "skip");
    expect(rowTwoDecision).toHaveProperty("value", "skip");

    await userDriver.selectOptions(within(importRegion).getByLabelText("批量处理方式"), "add");
    await userDriver.click(within(importRegion).getByRole("button", { name: "应用批量处理" }));

    expect(rowOneDecision).toHaveProperty("value", "add");
    expect(rowTwoDecision).toHaveProperty("value", "skip");

    await userDriver.selectOptions(within(importRegion).getByLabelText("批量处理方式"), "overwrite");
    await userDriver.click(within(importRegion).getByRole("button", { name: "应用批量处理" }));

    expect(rowOneDecision).toHaveProperty("value", "add");
    expect(rowTwoDecision).toHaveProperty("value", "overwrite");
  });
});
