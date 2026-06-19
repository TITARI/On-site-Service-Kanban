import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ExhibitionProjectSelector } from "@/components/exhibition-project-selector";

describe("ExhibitionProjectSelector", () => {
  it("switches the active project and creates a new project option", async () => {
    const user = userEvent.setup();
    const onProjectChange = vi.fn();
    const onProjectCreate = vi.fn();

    render(
      <ExhibitionProjectSelector
        currentProjectName="第23届中原农资双交会"
        projects={["第23届中原农资双交会", "第22届中原农资双交会"]}
        onProjectChange={onProjectChange}
        onProjectCreate={onProjectCreate}
      />
    );

    await user.selectOptions(screen.getByLabelText("当前展览项目"), "第22届中原农资双交会");

    expect(onProjectChange).toHaveBeenCalledWith("第22届中原农资双交会");

    await user.click(screen.getByRole("button", { name: "新建展览项目" }));
    const dialog = screen.getByRole("dialog", { name: "新建展览项目" });

    await user.type(within(dialog).getByLabelText("项目名称"), "第24届中原农资双交会");
    await user.click(within(dialog).getByRole("button", { name: "创建项目" }));

    expect(onProjectCreate).toHaveBeenCalledWith("第24届中原农资双交会");
    expect(onProjectChange).toHaveBeenLastCalledWith("第24届中原农资双交会");
    expect((screen.getByLabelText("当前展览项目") as HTMLSelectElement).value).toBe("第24届中原农资双交会");
  });
});
