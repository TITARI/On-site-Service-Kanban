import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ExhibitorImportWizard } from "@/components/exhibitor-import-wizard";

describe("ExhibitorImportWizard", () => {
  it("walks from upload to mapping confirmation and import preview", async () => {
    const user = userEvent.setup();
    const onImportFile = vi.fn();
    const inspectPayload = {
      sheets: [
        { sheetName: "普通绿色搭建汇总", selected: true, rows: 111, importable: true },
        { sheetName: "标展楣牌", selected: true, rows: 161, importable: true },
        { sheetName: "备注", selected: false, rows: 3, importable: false, skippedReason: "未识别展位号和展商列" }
      ],
      mappings: [
        {
          sheetName: "普通绿色搭建汇总",
          fieldLabel: "展位号",
          sourceColumn: "展位号",
          source: "rule",
          confidence: 1,
          samples: ["1ET06", "1AT27"],
          reason: "表头命中系统内置规则"
        },
        {
          sheetName: "普通绿色搭建汇总",
          fieldLabel: "面积",
          sourceColumn: "第二个展位号列",
          source: "rule",
          confidence: 1,
          samples: ["36", "54"],
          reason: "第二个展位号列样例为面积数字，系统按面积读取"
        },
        {
          sheetName: "标展楣牌",
          fieldLabel: "现场搭建成员",
          sourceColumn: "未识别",
          source: "manual",
          confidence: 0,
          samples: [],
          reason: "管理员确认后匹配现场搭建组成员"
        }
      ],
      records: [{
        boothNumber: "1ET06",
        companyName: "汕头市昌隆机械科技有限公司",
        companyShortName: "汕头市昌隆机械科技有限公司",
        salesOwner: "孙晓景",
        builder: "李铁：13607664172",
        location: "一楼 1E",
        area: "36",
        boothType: "普通绿搭"
      }]
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(inspectPayload), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ExhibitorImportWizard isImporting={false} onClose={vi.fn()} onImportFile={onImportFile} />);

    expect(screen.getByText("上传后先进入预览，不会立刻覆盖后台数据。")).not.toBeNull();
    expect(screen.getByText("系统只保留展位号、展商、位置、面积、类型、销售和现场搭建成员；原表其他列不会写入看板。")).not.toBeNull();

    const file = new File(["demo"], "第23届中原农资双交会后勤表.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
    await user.upload(screen.getByLabelText("导入展位数据文件"), file);

    expect(onImportFile).not.toHaveBeenCalled();
    const wizard = screen.getByRole("dialog", { name: "展商数据导入向导" });
    await within(wizard).findByLabelText("选择工作表 普通绿色搭建汇总");
    expect(within(wizard).getByText("确认系统要读取哪些列")).not.toBeNull();
    expect(within(wizard).getByText("展位号和展商是主关联字段；位置、面积、类型进入看板；搭建商只用于匹配现场搭建组成员。")).not.toBeNull();
    expect(within(wizard).getByText("必须能识别")).not.toBeNull();
    expect(within(wizard).getByText("展位号、展商。缺一个就先回原表补齐或稍后在差异弹窗里修正。")).not.toBeNull();
    expect(within(wizard).getByText("面积自动识别")).not.toBeNull();
    expect(within(wizard).getByText("如果第二个“展位号”列样例是 36、18、54，系统会按面积读取。")).not.toBeNull();
    expect((within(wizard).getByLabelText("选择工作表 普通绿色搭建汇总") as HTMLInputElement).checked).toBe(true);
    expect((within(wizard).getByLabelText("选择工作表 标展楣牌") as HTMLInputElement).checked).toBe(true);
    expect(within(wizard).getByRole("table", { name: "字段映射预览" })).not.toBeNull();
    expect(within(wizard).getByText("来源工作表")).not.toBeNull();
    expect(within(wizard).getAllByText("规则").length).toBeGreaterThan(0);
    expect(within(wizard).getByText("人工")).not.toBeNull();
    expect(within(wizard).getAllByText("1.00").length).toBeGreaterThan(0);
    expect(within(wizard).getAllByText("样例值").length).toBeGreaterThan(0);
    expect(within(wizard).getByText("第二个展位号列样例为面积数字，系统按面积读取")).not.toBeNull();

    await user.click(within(wizard).getByRole("button", { name: "确认字段映射" }));

    expect(await within(wizard).findByText("预览导入结果，确认后才写入")).not.toBeNull();
    expect(within(wizard).getByText("勾选每一类代表你已看过处理方式；未勾选时不能写入看板。")).not.toBeNull();
    expect(within(wizard).getAllByText("会写入看板").length).toBeGreaterThan(0);
    expect(within(wizard).getByText("选中工作表解析出的展商，以及字段映射确认后的业务字段。")).not.toBeNull();
    expect(within(wizard).getByText("不会保存")).not.toBeNull();
    expect(within(wizard).getByText("原表中和看板无关的列、智能推理过程和临时样例值。")).not.toBeNull();
    expect(within(wizard).getByText("候选展商")).not.toBeNull();
    expect(within(wizard).getByText("字段取值")).not.toBeNull();
    expect(within(wizard).getByText("搭建成员待分配")).not.toBeNull();
    expect(within(wizard).getByText("汕头市昌隆机械科技有限公司")).not.toBeNull();
    expect(within(wizard).getByRole("button", { name: "返回字段映射" })).not.toBeNull();
    expect(within(wizard).getByRole("button", { name: "确认并写入看板" }).hasAttribute("disabled")).toBe(true);

    await user.click(within(wizard).getByLabelText("我已确认候选展商会写入看板"));
    await user.click(within(wizard).getByLabelText("我已确认字段取值的处理方式"));
    await user.click(within(wizard).getByLabelText("我已了解未匹配成员会进入待分配"));
    await user.click(within(wizard).getByRole("button", { name: "确认并写入看板" }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onImportFile).toHaveBeenCalledWith(file, ["普通绿色搭建汇总", "标展楣牌"]);
    expect(within(wizard).getByText("导入确认已提交")).not.toBeNull();
  });
});
