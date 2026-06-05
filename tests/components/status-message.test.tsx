import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusMessage } from "@/components/status-message";

describe("StatusMessage", () => {
  it("announces errors immediately", () => {
    render(<StatusMessage tone="error">提交失败</StatusMessage>);

    expect(screen.getByRole("alert").textContent).toBe("提交失败");
  });

  it("announces ordinary status updates politely", () => {
    render(<StatusMessage>工单已提交</StatusMessage>);

    const status = screen.getByRole("status");
    expect(status.textContent).toBe("工单已提交");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });
});
