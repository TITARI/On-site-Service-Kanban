import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WxautoUpdatePanel } from "@/components/admin/wxauto-update-panel";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WxautoUpdatePanel", () => {
  it("publishes an installer with a dedicated publish token", async () => {
    const onPublished = vi.fn();
    const fetchMock = vi.fn(async () => Response.json({ release: { version: "0.2.0" } }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<WxautoUpdatePanel releases={[]} onPublished={onPublished} />);

    await user.type(screen.getByLabelText("版本号"), "0.2.0");
    await user.type(screen.getByLabelText("发布说明"), "Internal test");
    await user.type(screen.getByLabelText("发布令牌"), "publish-secret");
    await user.upload(screen.getByLabelText("安装包"), new File(["installer"], "setup.exe"));
    await user.click(screen.getByRole("button", { name: "发布桌面更新" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/admin/wxauto-updates", expect.objectContaining({
      method: "POST",
      headers: { "x-update-publish-token": "publish-secret" }
    })));
    expect(onPublished).toHaveBeenCalledOnce();
    const body = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(body.get("publishToken")).toBeNull();
    expect((screen.getByLabelText("发布令牌") as HTMLInputElement).value).toBe("");
  });

  it("renders existing releases with hash prefixes", () => {
    render(<WxautoUpdatePanel releases={[{
      version: "0.2.0",
      channel: "stable",
      fileName: "wxauto-desktop-Setup-0.2.0.exe",
      filePath: "data/wxauto-updates/0.2.0/wxauto-desktop-Setup-0.2.0.exe",
      fileSize: 123,
      sha256: "abcdef1234567890".padEnd(64, "0"),
      releaseNotes: "Internal test",
      manifest: { payload: "{}" },
      signature: "signature",
      publishedAt: "2026-06-05T08:00:00.000Z"
    }]} onPublished={vi.fn()} />);

    expect(screen.getByText("0.2.0")).not.toBeNull();
    expect(screen.getAllByText("stable").length).toBeGreaterThan(0);
    expect(screen.getByText(/abcdef123456/)).not.toBeNull();
  });
});
