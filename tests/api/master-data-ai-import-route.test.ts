import { beforeEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import { defaultConfig } from "@/lib/seed";
import type { AppRepository } from "@/lib/repositories/app-repository";
import { SESSION_COOKIE_NAMES } from "@/lib/services/session-service";

const ADMIN_TOKEN = Buffer.alloc(32, 7).toString("base64url");

const store = vi.hoisted(() => ({
  getConfig: vi.fn(),
  importBooths: vi.fn(),
  resolveAccountSession: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => ({
    kind: "file",
    getConfig: store.getConfig,
    importBooths: store.importBooths,
    resolveAccountSession: store.resolveAccountSession
  } as unknown as AppRepository)
}));

function request(body: unknown) {
  return new Request("http://localhost/api/admin/master-data", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `${SESSION_COOKIE_NAMES.admin}=${ADMIN_TOKEN}`
    },
    body: JSON.stringify(body)
  });
}

function multipartRequest(body: FormData) {
  const request = new Request("http://localhost/api/admin/master-data", {
    method: "POST",
    headers: {
      "content-type": "multipart/form-data; boundary=test-boundary",
      cookie: `${SESSION_COOKIE_NAMES.admin}=${ADMIN_TOKEN}`
    }
  });
  Object.defineProperty(request, "formData", { value: async () => body });
  return request;
}

describe("master data route AI assisted import", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    for (const mock of Object.values(store)) mock.mockReset();
    store.resolveAccountSession.mockResolvedValue({
      actor: {
        accountId: "admin-1",
        personId: "person-admin",
        name: "管理员",
        phone: "13800138000",
        groupName: "主场组",
        permissions: ["admin.access"],
        sessionType: "admin"
      },
      session: {
        id: "session-1",
        accountId: "admin-1",
        sessionType: "admin",
        tokenHash: "hash",
        authVersion: 1,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        lastSeenAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      }
    });
    store.getConfig.mockResolvedValue({
      ...defaultConfig(),
      aiModels: defaultConfig().aiModels.map((model) => model.id === "smart"
        ? { ...model, provider: "http", endpoint: "https://ai.example/v1/chat/completions", apiKey: "test-key", modelName: "gpt-smart" }
        : model)
    });
    store.importBooths.mockImplementation(async (booths) => booths);
  });

  it("uses configured smart AI to map unknown workbook headers before importing", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            mappings: [
              { field: "boothNumber", columnIndex: 0, confidence: 0.95, reason: "席位编码是展位号" },
              { field: "companyName", columnIndex: 1, confidence: 0.95, reason: "参展单位是展商名称" }
            ]
          })
        },
        finish_reason: "stop"
      }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const route = await import("@/app/api/admin/master-data/route");
    const response = await route.POST(request({
      sheets: [{
        sheetName: "普通绿色搭建汇总",
        rows: [
          ["席位编码", "参展单位", "楼层", "展馆", "销售人员", "搭建公司"],
          ["A09", "测试公司", "一楼", "1A", "赵测试", "青木搭建"]
        ]
      }]
    }));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith("https://ai.example/v1/chat/completions", expect.objectContaining({ method: "POST" }));
    expect(store.importBooths).toHaveBeenCalledWith([
      expect.objectContaining({
        boothNumber: "A09",
        companyName: "测试公司",
        salesOwner: "赵测试",
        builder: "青木搭建",
        location: "一楼 1A"
      })
    ]);
    await expect(response.json()).resolves.toMatchObject({
      records: [expect.objectContaining({ boothNumber: "A09", companyName: "测试公司" })],
      booths: [expect.objectContaining({ boothNumber: "A09", companyName: "测试公司" })]
    });
  });

  it("imports exported logistics workbook sheets with smart AI assisted field inference", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      const context = JSON.parse(body.messages[1].content);
      const mappings = context.sheetName === "普通绿色搭建汇总"
        ? [{ field: "area", columnIndex: 5, confidence: 0.96, reason: "第二个展位号列的样例是面积数值" }]
        : [];
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ mappings }) }, finish_reason: "stop" }]
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const route = await import("@/app/api/admin/master-data/route");
    const response = await route.POST(request({
      sheets: [
        {
          sheetName: "普通绿色搭建汇总",
          rows: [
            ["", "第23届中原农资双交会绿搭", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
            ["品类", "企业名称", "楼层", "展馆", "展位号", "展位号", "方案类型", "确定方案图片", "方案编号", "确认搭建方案", "画面是否提交", "展位画面已渲染", "画面已确定", "组别", "销售人员", "是否到款", "搭建商"],
            ["机械", "汕头市昌隆机械科技有限公司", "一楼", "1E", "1ET06", 36, "普通绿搭", "", "PT36-2", 1, "收到3.21", "", "", "中原一组", "孙晓晓", "半款", "李铁：13607664172"]
          ]
        },
        {
          sheetName: "标展楣牌",
          rows: [
            ["标展楣牌下单情况，已在提交批次里面需要修改的，请在备注中备注更改日期"],
            ["公司名称", "所属展馆", "展位号", "展位类别（普标）", "面积", "开口", "楣板数量", "组别", "销售人员", "是否到款", "备注"],
            ["山东省聊城经济开发区齐龙精细化工厂", "1E", "1E05", "精标", 9, "双开", 2, "农药二组", "韩世军", "全款", ""]
          ]
        }
      ]
    }));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
    expect(store.importBooths).toHaveBeenCalledWith([
      expect.objectContaining({
        boothNumber: "1E05",
        companyName: "山东省聊城经济开发区齐龙精细化工厂",
        location: "1E",
        area: "9",
        boothType: "精标",
        salesOwner: "韩世军"
      }),
      expect.objectContaining({
        boothNumber: "1ET06",
        companyName: "汕头市昌隆机械科技有限公司",
        location: "一楼 1E",
        area: "36",
        boothType: "普通绿搭",
        salesOwner: "孙晓晓",
        builder: "李铁：13607664172"
      })
    ]);
  });

  it("parses uploaded workbook files on the server before smart AI assisted field inference", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      const context = JSON.parse(body.messages[1].content);
      const mappings = context.sheetName === "普通绿色搭建汇总"
        ? [{ field: "area", columnIndex: 4, confidence: 0.96, reason: "面积列是数值面积" }]
        : [];
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ mappings }) }, finish_reason: "stop" }]
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["普通绿色搭建汇总"],
        ["企业名称", "楼层", "展馆", "展位号", "面积", "方案类型", "销售人员", "搭建商"],
        ["汕头市昌隆机械科技有限公司", "一楼", "1E", "1ET06", 36, "普通绿搭", "孙晓晓", "李铁：13607664172"]
      ]),
      "普通绿色搭建汇总"
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["标展楣牌下单情况"],
        ["公司名称", "所属展馆", "展位号", "展位类别（普标）", "面积", "销售人员"],
        ["安徽省安邦矿物股份有限公司", "1E", "1E01", "精标", 6, "孙晓晓"]
      ]),
      "标展楣牌"
    );
    const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    const formData = new FormData();
    formData.append(
      "file",
      new File([buffer], "logistics.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
    );
    formData.append("dryRun", "false");

    const route = await import("@/app/api/admin/master-data/route");
    const response = await route.POST(multipartRequest(formData));

    const responseBody = await response.clone().json();
    expect(response.status, JSON.stringify(responseBody)).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
    expect(store.importBooths).toHaveBeenCalledWith([
      expect.objectContaining({
        boothNumber: "1E01",
        companyName: "安徽省安邦矿物股份有限公司",
        location: "1E",
        area: "6",
        boothType: "精标",
        salesOwner: "孙晓晓"
      }),
      expect.objectContaining({
        boothNumber: "1ET06",
        companyName: "汕头市昌隆机械科技有限公司",
        location: "一楼 1E",
        area: "36",
        boothType: "普通绿搭",
        salesOwner: "孙晓晓",
        builder: "李铁：13607664172"
      })
    ]);
  });

  it("rejects oversized uploaded workbooks before reading them", async () => {
    const formData = new FormData();
    formData.append(
      "file",
      new File(
        [new Uint8Array(10 * 1024 * 1024 + 1)],
        "huge.xlsx",
        { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
      )
    );

    const route = await import("@/app/api/admin/master-data/route");
    const response = await route.POST(multipartRequest(formData));
    const payload = await response.json();

    expect(response.status).toBe(413);
    expect(payload.message).toBe("文件过大，请控制在 10MB 以内。");
    expect(store.importBooths).not.toHaveBeenCalled();
  });

  it("rejects uploaded workbooks with too many sheets or rows before expanding sheet JSON", async () => {
    const route = await import("@/app/api/admin/master-data/route");
    const manySheetsWorkbook = XLSX.utils.book_new();
    for (let index = 0; index < 11; index += 1) {
      XLSX.utils.book_append_sheet(
        manySheetsWorkbook,
        XLSX.utils.aoa_to_sheet([[`sheet-${index}`]]),
        `Sheet${index}`
      );
    }
    const manySheetsForm = new FormData();
    manySheetsForm.append(
      "file",
      new File([
        XLSX.write(manySheetsWorkbook, { type: "array", bookType: "xlsx" })
      ], "many-sheets.xlsx")
    );

    const manySheetsResponse = await route.POST(multipartRequest(manySheetsForm));
    await expect(manySheetsResponse.json()).resolves.toMatchObject({
      message: "工作表数量过多，请控制在 10 个以内。"
    });
    expect(manySheetsResponse.status).toBe(400);

    const manyRowsWorkbook = XLSX.utils.book_new();
    const manyRowsSheet = XLSX.utils.aoa_to_sheet([["展位号"]]);
    manyRowsSheet["!ref"] = "A1:A20001";
    XLSX.utils.book_append_sheet(manyRowsWorkbook, manyRowsSheet, "普通绿色搭建汇总");
    const manyRowsForm = new FormData();
    manyRowsForm.append(
      "file",
      new File([
        XLSX.write(manyRowsWorkbook, { type: "array", bookType: "xlsx" })
      ], "many-rows.xlsx")
    );

    const manyRowsResponse = await route.POST(multipartRequest(manyRowsForm));
    await expect(manyRowsResponse.json()).resolves.toMatchObject({
      message: "单个工作表行数过多，请控制在 20000 行以内。"
    });
    expect(manyRowsResponse.status).toBe(400);
    expect(store.importBooths).not.toHaveBeenCalled();
  });

  it("rejects oversized JSON import sheets, rows, and cells", async () => {
    const route = await import("@/app/api/admin/master-data/route");
    const tooManyRows = await route.POST(request({
      rows: Array.from({ length: 20_001 }, (_, index) => ({
        boothNumber: `A${index}`,
        companyName: "测试公司"
      }))
    }));
    await expect(tooManyRows.json()).resolves.toMatchObject({
      message: "JSON 行数过多，请控制在 20000 行以内。"
    });
    expect(tooManyRows.status).toBe(400);

    const tooManySheetRows = await route.POST(request({
      sheets: [{
        sheetName: "普通绿色搭建汇总",
        rows: Array.from({ length: 20_001 }, () => ["A01", "测试公司"])
      }]
    }));
    await expect(tooManySheetRows.json()).resolves.toMatchObject({
      message: "单个工作表行数过多，请控制在 20000 行以内。"
    });
    expect(tooManySheetRows.status).toBe(400);

    const longCell = await route.POST(request({
      rows: [{ boothNumber: "A01", companyName: "长".repeat(501) }]
    }));
    await expect(longCell.json()).resolves.toMatchObject({
      message: "单元格内容过长，请控制在 500 字以内。"
    });
    expect(longCell.status).toBe(400);
    expect(store.importBooths).not.toHaveBeenCalled();
  });

  it("returns workbook sheet inspection details without committing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ mappings: [] }) }, finish_reason: "stop" }]
    }), { status: 200 })));

    const route = await import("@/app/api/admin/master-data/route");
    const response = await route.POST(request({
      inspect: true,
      dryRun: true,
      sheets: [
        {
          sheetName: "普通绿色搭建汇总",
          rows: [
            ["企业名称", "楼层", "展馆", "展位号", "面积", "方案类型", "销售人员", "搭建商"],
            ["汕头市昌隆机械科技有限公司", "一楼", "1E", "1ET06", 36, "普通绿搭", "孙晓晓", "李铁：13607664172"]
          ]
        },
        {
          sheetName: "备注",
          rows: [["只是一张说明表"]]
        }
      ]
    }));

    expect(response.status).toBe(200);
    expect(store.importBooths).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      records: [expect.objectContaining({ boothNumber: "1ET06", companyName: "汕头市昌隆机械科技有限公司" })],
      sheets: [
        expect.objectContaining({ sheetName: "普通绿色搭建汇总", selected: true, importable: true }),
        expect.objectContaining({ sheetName: "备注", selected: false, importable: false })
      ],
      mappings: expect.arrayContaining([
        expect.objectContaining({
          sheetName: "普通绿色搭建汇总",
          fieldLabel: "展位号",
          sourceColumn: "展位号",
          source: "rule"
        })
      ])
    });
  });

  it("commits only the selected uploaded workbook sheets", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ mappings: [] }) }, finish_reason: "stop" }]
    }), { status: 200 })));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["普通绿色搭建汇总"],
        ["企业名称", "楼层", "展馆", "展位号", "面积", "方案类型", "销售人员", "搭建商"],
        ["汕头市昌隆机械科技有限公司", "一楼", "1E", "1ET06", 36, "普通绿搭", "孙晓晓", "李铁：13607664172"]
      ]),
      "普通绿色搭建汇总"
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["标展楣牌下单情况"],
        ["公司名称", "所属展馆", "展位号", "展位类别（普标）", "面积", "销售人员"],
        ["安徽省安邦矿物股份有限公司", "1E", "1E01", "精标", 6, "孙晓晓"]
      ]),
      "标展楣牌"
    );
    const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    const formData = new FormData();
    formData.append(
      "file",
      new File([buffer], "logistics.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
    );
    formData.append("dryRun", "false");
    formData.append("sheetNames", JSON.stringify(["标展楣牌"]));

    const route = await import("@/app/api/admin/master-data/route");
    const response = await route.POST(multipartRequest(formData));

    expect(response.status).toBe(200);
    expect(store.importBooths).toHaveBeenCalledWith([
      expect.objectContaining({
        boothNumber: "1E01",
        companyName: "安徽省安邦矿物股份有限公司"
      })
    ]);
    expect(store.importBooths).not.toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ boothNumber: "1ET06" })
    ]));
  });

  it("uses configured smart AI to import continuation sheets without headers", async () => {
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      const context = JSON.parse(body.messages[1].content);
      expect(context.sheetName).toBe("工作表1");
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              mappings: [
                { field: "companyName", columnIndex: 0, confidence: 0.96, reason: "样例都是展商名称" },
                { field: "floor", columnIndex: 1, confidence: 0.9, reason: "样例是一楼、二楼" },
                { field: "hall", columnIndex: 2, confidence: 0.9, reason: "样例是展馆编码" },
                { field: "boothNumber", columnIndex: 3, confidence: 0.97, reason: "样例是展位号" },
                { field: "area", columnIndex: 4, confidence: 0.94, reason: "样例是面积数字" },
                { field: "exhibitorType", columnIndex: 5, confidence: 0.9, reason: "样例是搭建类型" },
                { field: "builder", columnIndex: 6, confidence: 0.92, reason: "样例是现场搭建成员" }
              ]
            })
          },
          finish_reason: "stop"
        }]
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const route = await import("@/app/api/admin/master-data/route");
    const response = await route.POST(request({
      sheets: [{
        sheetName: "工作表1",
        rows: [
          ["广西金丝鸟农化有限公司", "一楼", "1A", "1AT13", 54, "普通绿搭", "李娜：15237810685"],
          ["河南柯睿纳生物科技有限公司", "一楼", "1A", "1AT15", 54, "普通绿搭", "李娜：15237810685"]
        ]
      }]
    }));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith("https://ai.example/v1/chat/completions", expect.objectContaining({ method: "POST" }));
    expect(store.importBooths).toHaveBeenCalledWith([
      expect.objectContaining({
        boothNumber: "1AT13",
        companyName: "广西金丝鸟农化有限公司",
        location: "一楼 1A",
        area: "54",
        boothType: "普通绿搭",
        builder: "李娜：15237810685"
      }),
      expect.objectContaining({
        boothNumber: "1AT15",
        companyName: "河南柯睿纳生物科技有限公司",
        location: "一楼 1A",
        area: "54",
        boothType: "普通绿搭",
        builder: "李娜：15237810685"
      })
    ]);
  });

  it("rejects unsupported MIME types with 415", async () => {
    const formData = new FormData();
    formData.append(
      "file",
      new File([new Uint8Array([0x50, 0x4b])], "data.xlsx", { type: "text/plain" })
    );

    const route = await import("@/app/api/admin/master-data/route");
    const response = await route.POST(multipartRequest(formData));

    expect(response.status).toBe(415);
  });

  it("rejects unsupported file extensions with 400", async () => {
    const formData = new FormData();
    formData.append(
      "file",
      new File([new Uint8Array([0x50, 0x4b])], "data.txt", { type: "application/octet-stream" })
    );

    const route = await import("@/app/api/admin/master-data/route");
    const response = await route.POST(multipartRequest(formData));

    expect(response.status).toBe(400);
  });

  it("returns a friendly 400 for corrupted xlsx bytes instead of 500", async () => {
    const formData = new FormData();
    formData.append(
      "file",
      new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])], "corrupt.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
    );

    const route = await import("@/app/api/admin/master-data/route");
    const response = await route.POST(multipartRequest(formData));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.message).toBe("工作簿解析失败，请检查文件格式。");
  });
});
