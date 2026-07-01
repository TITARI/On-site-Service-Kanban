import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ExhibitorDashboard } from "@/components/exhibitor-dashboard";
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
  },
  {
    boothNumber: "1E05",
    companyName: "山东省聊城经济开发区齐龙精细化工厂",
    companyShortName: "齐龙精细化工厂",
    location: "1E",
    area: "9",
    boothType: "精标",
    salesOwner: "韩世军",
    builder: ""
  },
  {
    boothNumber: "1AT27",
    companyName: "郑州鼎来瑞农业科技有限公司",
    companyShortName: "鼎来瑞",
    location: "一楼 / 1A",
    area: "18",
    boothType: "普通绿搭",
    salesOwner: "马永波",
    builder: "崔晓安：13803812794、王宁：13700001111"
  },
  {
    boothNumber: "1AT27",
    companyName: "郑州鑫利农农业科技有限公司",
    companyShortName: "鑫利农",
    location: "一楼 / 1A",
    area: "18",
    boothType: "普通绿搭",
    salesOwner: "马永波",
    builder: "崔晓安：13803812794"
  }
];

function makePaginationBooths(count: number): BoothRecord[] {
  return Array.from({ length: count }, (_, index) => {
    const row = index + 1;
    return {
      boothNumber: `P${String(row).padStart(2, "0")}`,
      companyName: `Company ${row}`,
      companyShortName: `C${row}`,
      location: row % 2 === 0 ? "Hall B" : "Hall A",
      area: "9",
      boothType: "Standard",
      salesOwner: "Sales",
      builder: row % 3 === 0 ? "Builder A" : ""
    };
  });
}

describe("ExhibitorDashboard", () => {
  it("renders the approved prototype shell as a standalone exhibitor dashboard", async () => {
    const user = userEvent.setup();

    render(<ExhibitorDashboard booths={booths} isImporting={false} onImportFile={vi.fn()} />);

    expect(screen.getByText("管理后台 / 展商数据")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "展商数据看板" })).not.toBeNull();
    expect(screen.getByText("以展位号与展商为核心，统一管理项目展商资料和现场搭建成员。")).not.toBeNull();
    expect(screen.getByLabelText("当前展览项目")).not.toBeNull();
    expect(screen.getByRole("option", { name: "全部位置" })).not.toBeNull();
    expect(screen.getByRole("option", { name: "全部类型" })).not.toBeNull();
    expect(screen.getByRole("option", { name: "全部分配状态" })).not.toBeNull();

    const metrics = screen.getByLabelText("项目数据概览");
    expect(within(metrics).getByText("系统展商")).not.toBeNull();
    expect(within(metrics).getByText("4")).not.toBeNull();
    expect(within(metrics).getByText("已分配搭建成员")).not.toBeNull();
    expect(within(metrics).getByText("待分配成员")).not.toBeNull();
    expect(within(metrics).getByText("待确认导入差异")).not.toBeNull();
    expect(within(metrics).getByText("来自 2 张有效工作表")).not.toBeNull();
    expect(within(metrics).getByText("75% 已完成成员关联")).not.toBeNull();
    expect(within(metrics).getByText("可按展馆批量分配")).not.toBeNull();
    expect(within(metrics).getByText("不影响当前系统数据")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "导入历史" }));
    const historyPanel = screen.getByRole("region", { name: "导入历史面板" });
    expect(within(historyPanel).getByText("普通绿色搭建汇总 / 标展楣牌")).not.toBeNull();

    const table = screen.getByRole("table", { name: "展商数据表格" });
    ["展位号", "展商", "位置", "面积", "类型", "销售", "现场搭建成员", "操作"].forEach((header) => {
      expect(within(table).getByRole("columnheader", { name: header })).not.toBeNull();
    });
    expect(within(table).getAllByText("1AT27")).toHaveLength(2);
    expect(within(table).getAllByText("同展位存在其他展商")).toHaveLength(2);

    await user.click(within(table).getByRole("button", { name: "查看汕头市昌隆机械科技有限公司" }));
    const drawer = screen.getByRole("dialog", { name: "展商详情" });
    expect(within(drawer).getByRole("heading", { name: "汕头市昌隆机械科技有限公司" })).not.toBeNull();
    expect(within(drawer).getByText("展商基础数据")).not.toBeNull();
    expect(within(drawer).getByText("面积规格")).not.toBeNull();
    expect(within(drawer).getByText("规格待补充")).not.toBeNull();
    expect(within(drawer).getByText("现场搭建成员")).not.toBeNull();
    expect(within(drawer).getByText("136****4172")).not.toBeNull();
    expect(within(drawer).getByRole("button", { name: "取消" })).not.toBeNull();
    expect(within(drawer).getByRole("button", { name: "编辑展商数据" })).not.toBeNull();
  });

  it("traps focus in the detail drawer, closes with Escape, and restores the opener", async () => {
    const user = userEvent.setup();
    render(<ExhibitorDashboard booths={[booths[0]]} isImporting={false} onImportFile={vi.fn()} />);

    const table = screen.getByRole("table", { name: "展商数据表格" });
    const opener = within(table).getByRole("button", { name: `查看${booths[0].companyName}` });
    await user.click(opener);

    const drawer = screen.getByRole("dialog", { name: "展商详情" });
    expect(drawer.contains(document.activeElement)).toBe(true);

    const firstButton = within(drawer).getByRole("button", { name: "关闭详情" });
    const buttons = within(drawer).getAllByRole("button");
    buttons.at(-1)?.focus();
    await user.tab();
    expect(document.activeElement).toBe(firstButton);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "展商详情" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(
      within(table).getByRole("button", { name: `查看${booths[0].companyName}` })
    ));
  });

  it("dismisses type settings with Escape and restores focus", async () => {
    const user = userEvent.setup();
    render(<ExhibitorDashboard booths={booths.slice(0, 2)} isImporting={false} onImportFile={vi.fn()} />);

    const opener = screen.getByRole("button", { name: "类型设置" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "展商类型设置" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "展商类型设置" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("closes nested member assignment before the detail drawer and restores focus inside the drawer", async () => {
    const user = userEvent.setup();
    render(<ExhibitorDashboard booths={[booths[0]]} isImporting={false} onImportFile={vi.fn()} />);

    const table = screen.getByRole("table", { name: "展商数据表格" });
    await user.click(within(table).getByRole("button", { name: `查看${booths[0].companyName}` }));
    const drawer = screen.getByRole("dialog", { name: "展商详情" });
    const opener = within(drawer).getByRole("button", { name: "添加现场搭建成员" });
    await user.click(opener);

    expect(screen.getByRole("dialog", { name: "分配现场搭建成员" })).not.toBeNull();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "分配现场搭建成员" })).toBeNull();
    const restoredDrawer = screen.getByRole("dialog", { name: "展商详情" });
    const restoredOpener = within(restoredDrawer).getByRole("button", { name: "添加现场搭建成员" });
    await waitFor(() => expect(document.activeElement).toBe(restoredOpener));
  });

  it("dismisses import diff with Escape and restores focus", async () => {
    const user = userEvent.setup();
    const diffBooth: BoothRecord = {
      ...booths[0],
      companyName: "导入缺字段展商",
      companyShortName: "",
      location: "",
      area: "",
      boothType: ""
    };
    render(<ExhibitorDashboard booths={[diffBooth]} isImporting={false} onImportFile={vi.fn()} />);

    const opener = screen.getByRole("button", { name: "处理导入差异" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "导入差异数值确认" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "导入差异数值确认" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("dismisses exhibitor editing before the drawer and restores focus", async () => {
    const user = userEvent.setup();
    render(<ExhibitorDashboard booths={[booths[0]]} isImporting={false} onImportFile={vi.fn()} />);

    const table = screen.getByRole("table", { name: "展商数据表格" });
    await user.click(within(table).getByRole("button", { name: `查看${booths[0].companyName}` }));
    const drawer = screen.getByRole("dialog", { name: "展商详情" });
    const opener = within(drawer).getByRole("button", { name: "编辑展商数据" });
    await user.click(opener);

    expect(screen.getByRole("dialog", { name: "编辑展商数据" })).not.toBeNull();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "编辑展商数据" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "展商详情" })).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("dismisses batch type with Escape and restores focus", async () => {
    const user = userEvent.setup();
    render(<ExhibitorDashboard booths={booths.slice(0, 2)} isImporting={false} onImportFile={vi.fn()} />);

    const table = screen.getByRole("table", { name: "展商数据表格" });
    await user.click(within(table).getByLabelText(`选择${booths[0].companyName}`));
    const opener = screen.getByRole("button", { name: "批量修改类型" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "批量修改类型" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "批量修改类型" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("uses an alertdialog for batch disable and cancels with Escape", async () => {
    const user = userEvent.setup();
    render(<ExhibitorDashboard booths={booths.slice(0, 2)} isImporting={false} onImportFile={vi.fn()} />);

    const table = screen.getByRole("table", { name: "展商数据表格" });
    await user.click(within(table).getByLabelText(`选择${booths[0].companyName}`));
    const opener = screen.getByRole("button", { name: "批量停用" });
    await user.click(opener);
    const alert = screen.getByRole("alertdialog", { name: "批量停用展商" });
    expect(document.activeElement).toBe(within(alert).getByRole("button", { name: "取消" }));

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog", { name: "批量停用展商" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(within(table).queryByText("已停用")).toBeNull();
  });

  it("edits only the approved exhibitor business fields from the detail drawer", async () => {
    const user = userEvent.setup();

    render(<ExhibitorDashboard booths={[booths[0]]} isImporting={false} onImportFile={vi.fn()} />);

    const table = screen.getByRole("table", { name: "展商数据表格" });
    await user.click(within(table).getByRole("button", { name: "查看汕头市昌隆机械科技有限公司" }));
    await user.click(screen.getByRole("button", { name: "编辑展商数据" }));

    const dialog = screen.getByRole("dialog", { name: "编辑展商数据" });
    expect(within(dialog).getByText("只保留展位号、展商、位置、面积、面积规格、类型、销售七项基础数据。")).not.toBeNull();
    expect(within(dialog).queryByText(/搭建商七项基础数据/)).toBeNull();
    ["展位号", "展商", "位置", "面积", "面积规格", "类型", "销售"].forEach((field) => {
      expect(within(dialog).getByLabelText(field)).not.toBeNull();
    });
    expect(within(dialog).queryByLabelText("公司简称")).toBeNull();
    expect(within(dialog).queryByLabelText("搭建商")).toBeNull();

    await user.clear(within(dialog).getByLabelText("销售"));
    await user.type(within(dialog).getByLabelText("销售"), "王新");
    await user.clear(within(dialog).getByLabelText("面积"));
    await user.type(within(dialog).getByLabelText("面积"), "36");
    await user.clear(within(dialog).getByLabelText("面积规格"));
    await user.type(within(dialog).getByLabelText("面积规格"), "6×6m");
    await user.click(within(dialog).getByRole("button", { name: "保存展商数据" }));

    expect(screen.queryByRole("dialog", { name: "编辑展商数据" })).toBeNull();
    expect(within(table).getByText("王新")).not.toBeNull();
    expect(within(table).getByText("36㎡")).not.toBeNull();
    expect(within(table).getByText("6×6m")).not.toBeNull();
    const drawer = screen.getByRole("dialog", { name: "展商详情" });
    expect(within(drawer).getByText("王新")).not.toBeNull();
  });

  it("batch changes the exhibitor type for selected rows", async () => {
    const user = userEvent.setup();

    render(<ExhibitorDashboard booths={booths.slice(0, 2)} isImporting={false} onImportFile={vi.fn()} />);

    const table = screen.getByRole("table", { name: "展商数据表格" });
    await user.click(within(table).getByLabelText("选择汕头市昌隆机械科技有限公司"));
    await user.click(within(table).getByLabelText("选择山东省聊城经济开发区齐龙精细化工厂"));
    await user.click(screen.getByRole("button", { name: "批量修改类型" }));

    const dialog = screen.getByRole("dialog", { name: "批量修改类型" });
    await user.selectOptions(within(dialog).getByLabelText("目标类型"), "普标");
    await user.click(within(dialog).getByRole("button", { name: "确认修改类型" }));

    expect(screen.queryByRole("dialog", { name: "批量修改类型" })).toBeNull();
    expect(within(table).getAllByText("普标")).toHaveLength(2);
  });

  it("manages exhibitor types from the settings dialog", async () => {
    const user = userEvent.setup();

    render(<ExhibitorDashboard booths={booths.slice(0, 2)} isImporting={false} onImportFile={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "类型设置" }));
    const dialog = screen.getByRole("dialog", { name: "展商类型设置" });

    await user.clear(within(dialog).getByLabelText("普通绿搭类型名称"));
    await user.type(within(dialog).getByLabelText("普通绿搭类型名称"), "标准绿搭");
    await user.click(within(dialog).getByRole("button", { name: "保存普通绿搭类型名称" }));

    expect(within(dialog).getByText("标准绿搭")).not.toBeNull();
    expect(within(dialog).queryByText("普通绿搭")).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "下移标准绿搭" }));
    const typeNames = within(dialog).getAllByRole("textbox", { name: /类型名称$/ }).map((input) => (input as HTMLInputElement).value);
    expect(typeNames[0]).toBe("普标");
    expect(typeNames[1]).toBe("标准绿搭");

    await user.click(within(dialog).getByRole("button", { name: "停用标准绿搭" }));
    expect(within(dialog).getByText("已停用")).not.toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "启用标准绿搭" }));
    expect(within(dialog).queryByText("已停用")).toBeNull();
  });

  it("batch assigns selected exhibitors to builder members", async () => {
    const user = userEvent.setup();

    render(<ExhibitorDashboard booths={booths.slice(1, 3)} isImporting={false} onImportFile={vi.fn()} />);

    const table = screen.getByRole("table", { name: "展商数据表格" });
    await user.click(within(table).getByLabelText("选择山东省聊城经济开发区齐龙精细化工厂"));
    await user.click(within(table).getByLabelText("选择郑州鼎来瑞农业科技有限公司"));
    await user.click(screen.getByRole("button", { name: "批量分配搭建成员" }));

    const dialog = screen.getByRole("dialog", { name: "批量分配现场搭建成员" });
    await user.click(within(dialog).getByLabelText("李铁"));
    await user.click(within(dialog).getByLabelText("王宁"));
    await user.click(within(dialog).getByRole("button", { name: "确认分配" }));

    expect(screen.queryByRole("dialog", { name: "批量分配现场搭建成员" })).toBeNull();
    expect(within(table).getAllByLabelText("李铁")).toHaveLength(2);
    expect(within(table).getAllByLabelText("王宁")).toHaveLength(2);
  });

  it("keeps batch member assignment usable when many exhibitors are selected", async () => {
    const user = userEvent.setup();

    render(<ExhibitorDashboard booths={makePaginationBooths(12)} isImporting={false} onImportFile={vi.fn()} />);

    await user.selectOptions(screen.getByLabelText("每页条数"), "20");
    const table = screen.getByRole("table", { name: "展商数据表格" });
    await user.click(within(table).getByLabelText("选择当前页全部展商"));
    await user.click(screen.getByRole("button", { name: "批量分配搭建成员" }));

    const dialog = screen.getByRole("dialog", { name: "批量分配现场搭建成员" });
    expect(dialog.classList.contains("exhibitor-member-assignment-dialog")).toBe(true);
    expect(within(dialog).getByText("已选择 12 个展商")).not.toBeNull();
    const scrollBody = within(dialog).getByLabelText("批量分配可滚动内容");
    expect(scrollBody.classList.contains("exhibitor-assignment-scrollbody")).toBe(true);
    expect(within(scrollBody).getByLabelText("已选择展商列表")).not.toBeNull();
    expect(within(scrollBody).getByLabelText("可选搭建组成员")).not.toBeNull();
    const actions = within(dialog).getByRole("group", { name: "成员分配操作" });
    expect(actions.classList.contains("exhibitor-assignment-sticky-actions")).toBe(true);
    expect(within(actions).getByRole("button", { name: "确认分配" })).not.toBeNull();
  });

  it("allows an administrator to disable and re-enable an exhibitor from the detail drawer", async () => {
    const user = userEvent.setup();

    render(<ExhibitorDashboard booths={[booths[0]]} isImporting={false} onImportFile={vi.fn()} />);

    const table = screen.getByRole("table", { name: "展商数据表格" });
    await user.click(within(table).getByRole("button", { name: "查看汕头市昌隆机械科技有限公司" }));

    const drawer = screen.getByRole("dialog", { name: "展商详情" });
    await user.click(within(drawer).getByRole("button", { name: "停用展商" }));

    const enableButton = within(drawer).getByRole("button", { name: "启用汕头市昌隆机械科技有限公司" });
    expect(enableButton).not.toBeNull();
    await user.click(enableButton);
    await user.click(within(drawer).getByRole("button", { name: "关闭详情" }));

    await waitFor(() => {
      expect(within(table).queryByText("已停用")).toBeNull();
      expect(within(table).getByRole("button", { name: "查看汕头市昌隆机械科技有限公司" })).not.toBeNull();
    });
  });

  it("asks for confirmation before batch disabling exhibitors", async () => {
    const user = userEvent.setup();

    render(<ExhibitorDashboard booths={booths.slice(0, 2)} isImporting={false} onImportFile={vi.fn()} />);

    const table = screen.getByRole("table", { name: "展商数据表格" });
    await user.click(within(table).getByLabelText("选择汕头市昌隆机械科技有限公司"));
    await user.click(within(table).getByLabelText("选择山东省聊城经济开发区齐龙精细化工厂"));
    await user.click(screen.getByRole("button", { name: "批量停用" }));

    const dialog = screen.getByRole("alertdialog", { name: "批量停用展商" });
    expect(within(dialog).getByText("已选择 2 个展商，停用后将从默认可用列表中移出。")).not.toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "确认停用展商" }));

    expect(screen.queryByRole("alertdialog", { name: "批量停用展商" })).toBeNull();
    await waitFor(() => expect(within(table).getAllByText("已停用")).toHaveLength(2));
  });

  it("opens an editable import-diff dialog and applies confirmed values", async () => {
    const user = userEvent.setup();
    const diffBooths: BoothRecord[] = [{
      boothNumber: "D01",
      companyName: "导入缺字段展商",
      companyShortName: "导入缺字段展商",
      location: "",
      area: "",
      boothType: "",
      salesOwner: "赵导入",
      builder: ""
    }];

    render(<ExhibitorDashboard booths={diffBooths} isImporting={false} onImportFile={vi.fn()} />);

    expect(screen.getByText("1 条导入差异待确认")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "处理导入差异" }));

    const dialog = screen.getByRole("dialog", { name: "导入差异数值确认" });
    expect(within(dialog).getByText("这些记录缺少看板必需字段，先在这里补齐；点击应用后只更新当前看板字段。")).not.toBeNull();
    expect(within(dialog).getByText("填写建议")).not.toBeNull();
    expect(within(dialog).getByText("位置填展馆/楼层，例如“一楼 / 1A”；面积只填数字或规格，例如“18”或“3×3m”；类型选项目内名称，例如“普通绿搭”。")).not.toBeNull();
    expect(within(dialog).getByText("应用后结果")).not.toBeNull();
    expect(within(dialog).getByText("补齐展位、展商、位置、面积、类型后，这条记录会从“待确认导入差异”中移出。")).not.toBeNull();
    expect(within(dialog).getByText("导入缺字段展商")).not.toBeNull();
    expect(within(dialog).getByText("缺失位置")).not.toBeNull();
    expect(within(dialog).getByText("缺失面积")).not.toBeNull();
    expect(within(dialog).getByText("缺失类型")).not.toBeNull();
    expect((within(dialog).getByRole("button", { name: "应用到看板并移出待确认" }) as HTMLButtonElement).disabled).toBe(true);

    await user.type(within(dialog).getByLabelText("导入缺字段展商位置"), "一楼 / 1A");
    await user.type(within(dialog).getByLabelText("导入缺字段展商面积"), "18");
    await user.type(within(dialog).getByLabelText("导入缺字段展商类型"), "普通绿搭");
    expect((within(dialog).getByRole("button", { name: "应用到看板并移出待确认" }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "应用到看板并移出待确认" }));

    expect(screen.queryByRole("dialog", { name: "导入差异数值确认" })).toBeNull();
    const table = screen.getByRole("table", { name: "展商数据表格" });
    expect(within(table).getByText("一楼 / 1A")).not.toBeNull();
    expect(within(table).getByText("18㎡")).not.toBeNull();
    expect(within(table).getByText("普通绿搭")).not.toBeNull();
    expect(screen.getByText("0 条导入差异待确认")).not.toBeNull();
  });

  it("paginates exhibitors like a normal data table", async () => {
    const user = userEvent.setup();

    render(<ExhibitorDashboard booths={makePaginationBooths(23)} isImporting={false} onImportFile={vi.fn()} />);

    const table = screen.getByRole("table");
    expect(within(table).getByText("Company 1")).not.toBeNull();
    expect(within(table).getByText("Company 10")).not.toBeNull();
    expect(within(table).queryByText("Company 11")).toBeNull();
    expect(screen.getByText("共 23 条，显示 1-10 条")).not.toBeNull();

    const pagination = screen.getByRole("navigation", { name: "分页" });
    const previousButton = within(pagination).getByRole("button", { name: "上一页" }) as HTMLButtonElement;
    expect(previousButton.disabled).toBe(true);

    await user.click(within(pagination).getByRole("button", { name: "下一页" }));
    expect(within(table).queryByText("Company 1")).toBeNull();
    expect(within(table).getByText("Company 11")).not.toBeNull();
    expect(within(table).getByText("Company 20")).not.toBeNull();
    expect(screen.getByText("共 23 条，显示 11-20 条")).not.toBeNull();

    await user.click(within(pagination).getByRole("button", { name: "3" }));
    expect(within(table).queryByText("Company 20")).toBeNull();
    expect(within(table).getByText("Company 21")).not.toBeNull();
    expect(within(table).getByText("Company 23")).not.toBeNull();
    expect(screen.getByText("共 23 条，显示 21-23 条")).not.toBeNull();
    const nextButton = within(pagination).getByRole("button", { name: "下一页" }) as HTMLButtonElement;
    expect(nextButton.disabled).toBe(true);

    await user.selectOptions(screen.getByLabelText("每页条数"), "20");
    expect(within(table).getByText("Company 1")).not.toBeNull();
    expect(within(table).getByText("Company 20")).not.toBeNull();
    expect(within(table).queryByText("Company 21")).toBeNull();
    expect(screen.getByText("共 23 条，显示 1-20 条")).not.toBeNull();
    expect(within(pagination).getByRole("button", { name: "1" }).getAttribute("aria-current")).toBe("page");

    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "Company 2");
    expect(within(table).getByText("Company 2")).not.toBeNull();
    expect(screen.getByText("共 5 条，显示 1-5 条")).not.toBeNull();
    const activePage = within(pagination).getByRole("button", { name: "1" });
    expect(activePage.getAttribute("aria-current")).toBe("page");
  });

  it("shows prototype-style area specs, member add affordance and compact pagination", () => {
    render(<ExhibitorDashboard booths={booths} isImporting={false} onImportFile={vi.fn()} />);

    const table = screen.getByRole("table", { name: "展商数据表格" });
    expect(within(table).getByText("36㎡")).not.toBeNull();
    expect(within(table).getAllByText("规格待补充").length).toBeGreaterThan(0);
    expect(within(table).getByText("9㎡")).not.toBeNull();
    expect(within(table).getByText("3×3m")).not.toBeNull();

    const addMemberButtons = within(table).getAllByRole("button", { name: /添加.*搭建成员/ });
    expect(addMemberButtons[0].textContent).toBe("+");

    expect(screen.getByText("共 4 条，显示 1-4 条")).not.toBeNull();
    const pagination = screen.getByRole("navigation", { name: "分页" });
    expect(within(pagination).getByRole("button", { name: "1" }).getAttribute("aria-current")).toBe("page");
    expect((within(pagination).getByRole("button", { name: "上一页" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(pagination).getByRole("button", { name: "下一页" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens the import wizard from the visible upload action", async () => {
    const user = userEvent.setup();
    const onImportFile = vi.fn();
    const inspectPayload = {
      sheets: [{ sheetName: "普通绿色搭建汇总", selected: true, rows: 1, importable: true }],
      mappings: [{
        sheetName: "普通绿色搭建汇总",
        fieldLabel: "展位号",
        sourceColumn: "展位号",
        source: "rule",
        confidence: 1,
        samples: ["1ET06"],
        reason: "表头命中系统内置规则"
      }],
      records: [{
        boothNumber: "1ET06",
        companyName: "汕头市昌隆机械科技有限公司",
        companyShortName: "汕头市昌隆机械科技有限公司",
        salesOwner: "孙晓晓",
        builder: "李铁：13607664172"
      }]
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(inspectPayload), { status: 200 })));

    render(<ExhibitorDashboard booths={booths} isImporting={false} onImportFile={onImportFile} />);

    await user.click(screen.getByRole("button", { name: "上传项目表格" }));

    const wizard = screen.getByRole("dialog", { name: "展商数据导入向导" });
    expect(within(wizard).getByText("1 上传工作簿")).not.toBeNull();
    expect(within(wizard).getByText("2 确认读取字段")).not.toBeNull();
    expect(within(wizard).getByText("3 预览并写入")).not.toBeNull();
    expect(within(wizard).getByLabelText("导入展位数据文件")).not.toBeNull();

    const file = new File(["demo"], "logistics.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
    await user.upload(within(wizard).getByLabelText("导入展位数据文件"), file);

    expect(onImportFile).not.toHaveBeenCalled();
    await within(wizard).findByLabelText("选择工作表 普通绿色搭建汇总");
    await user.click(within(wizard).getByRole("button", { name: "确认字段映射" }));
    await within(wizard).findByText("预览导入结果，确认后才写入");
    await user.click(within(wizard).getByLabelText("我已确认候选展商会写入看板"));
    await user.click(within(wizard).getByLabelText("我已确认字段取值的处理方式"));
    await user.click(within(wizard).getByLabelText("我已了解未匹配成员会进入待分配"));
    await user.click(within(wizard).getByRole("button", { name: "确认并写入看板" }));
    expect(onImportFile).toHaveBeenCalledWith(file, ["普通绿色搭建汇总"]);
  });
});

describe("ExhibitorDashboard table selection lifecycle", () => {
  it("clears table selection when the incoming exhibitor dataset changes", async () => {
    const driver = userEvent.setup();
    const { rerender } = render(
      <ExhibitorDashboard booths={makePaginationBooths(2)} isImporting={false} onImportFile={vi.fn()} />
    );
    await driver.click(within(screen.getByRole("table", { name: "展商数据表格" })).getByLabelText("选择Company 1"));
    expect(screen.getByText("已选择 1 个展商")).not.toBeNull();

    rerender(
      <ExhibitorDashboard
        booths={makePaginationBooths(2).map((booth, index) => ({
          ...booth,
          boothNumber: `R${index + 1}`,
          companyName: `Replacement ${index + 1}`
        }))}
        isImporting={false}
        onImportFile={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.queryByText("已选择 1 个展商")).toBeNull());
  });
});
