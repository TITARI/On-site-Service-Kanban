import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TicketSubmitForm } from "@/components/ticket-submit-form";
import type { CurrentUser } from "@/lib/client/auth";
import type { AppConfig } from "@/lib/seed";
import { queryKeys } from "@/lib/client/query-keys";
import { renderWithQueryClient as render } from "../helpers/query-client";

const config: AppConfig = {
  issueTypes: [{ id: "network", name: "网络", urgencyMinutes: 20, priorityWeight: 25, assignmentGroup: "网络组", enabled: true }],
  aiModels: [
    { id: "fast", label: "快速智能模型", provider: "mock", modelName: "fast-local", timeoutMs: 800, enabled: true },
    { id: "smart", label: "高阶智能模型", provider: "mock", modelName: "smart-local", timeoutMs: 3000, enabled: true }
  ],
  assignmentRules: []
};

const currentUser: CurrentUser = { id: "member-13800138000", name: "张三", phone: "13800138000", role: "member" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TicketSubmitForm", () => {
  it("announces submit failures as alerts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 400 })));
    const user = userEvent.setup();

    render(<TicketSubmitForm config={config} currentUser={currentUser} onSubmitted={vi.fn()} />);

    await user.type(screen.getByRole("textbox", { name: "展位号" }), "A01");
    await user.type(screen.getByRole("textbox", { name: "问题描述" }), "网络断开，现场无法扫码");
    await user.click(screen.getByRole("button", { name: "提交工单" }));

    expect((await screen.findByRole("alert")).textContent).toBe("提交失败，请检查展位号和问题描述后重试");
  });

  it("submits selected images without client submitter identity fields", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ kind: "created" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onSubmitted = vi.fn();
    const user = userEvent.setup();

    const { queryClient } = render(<TicketSubmitForm config={config} currentUser={currentUser} onSubmitted={onSubmitted} />);
    queryClient.setQueryData(queryKeys.mobile.bootstrap, { tickets: [], config });

    expect(screen.getByText("张三")).not.toBeNull();
    expect(screen.getByText("13800138000")).not.toBeNull();
    await user.type(screen.getByRole("textbox", { name: "展位号" }), "A01");
    await user.type(screen.getByRole("textbox", { name: "问题描述" }), "网络断开，现场无法扫码");
    await user.upload(screen.getByLabelText("问题图片"), new File(["image-bytes"], "现场.jpg", { type: "image/jpeg" }));
    await user.click(screen.getByRole("button", { name: "提交工单" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).not.toHaveProperty("submitterId");
    expect(body).not.toHaveProperty("submitterName");
    expect(body).not.toHaveProperty("submitterPhone");
    expect(body).toMatchObject({
      boothNumber: "A01",
      description: "网络断开，现场无法扫码",
      issueType: "自动"
    });
    expect(body.imageUrls).toHaveLength(1);
    expect(body.imageUrls[0]).toMatch(/^data:image\/jpeg;base64,/);
    expect(onSubmitted).toHaveBeenCalled();
    expect(queryClient.getQueryState(queryKeys.mobile.bootstrap)?.isInvalidated).toBe(true);
  });
});
