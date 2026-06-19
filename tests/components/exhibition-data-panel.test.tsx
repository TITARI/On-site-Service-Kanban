import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExhibitionDataPanel } from "@/components/exhibition-data-panel";
import type { BoothRecord } from "@/lib/domain/types";

const booths: BoothRecord[] = [
  {
    boothNumber: "1ET06",
    companyName: "汕头市昌隆机械科技有限公司",
    companyShortName: "昌隆机械",
    location: "一楼 / 1E",
    area: "36",
    boothType: "普通绿搭",
    salesOwner: "孙晓晓",
    builder: "李铁：13607664172"
  }
];

describe("ExhibitionDataPanel", () => {
  it("renders the approved prototype dashboard shell without an extra wrapper hero", () => {
    render(<ExhibitionDataPanel booths={booths} isImporting={false} onImportFile={vi.fn()} />);

    expect(screen.getByRole("region", { name: "展览数据管理台" })).not.toBeNull();
    expect(screen.getByText("管理后台 / 展商数据")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "展商数据看板" })).not.toBeNull();
    expect(screen.getByText("以展位号与展商为核心，统一管理项目展商资料和现场搭建成员。")).not.toBeNull();
    expect(screen.getByLabelText("当前展览项目")).not.toBeNull();
    expect(screen.getByRole("button", { name: "新建展览项目" })).not.toBeNull();
    expect(screen.queryByRole("note", { name: "AI辅助导入提示" })).toBeNull();
    expect(screen.getByRole("table", { name: "展商数据表格" })).not.toBeNull();
  });
});
