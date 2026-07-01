# TanStack Table Migration Design

## 目标

用 `@tanstack/react-table` v8 替换展商看板和后台用户列表中手写的行模型、分页与选择逻辑，同时保持现有视觉、可访问性语义和业务操作不变。

## 现状与约束

- `exhibitor-dashboard.tsx` 持有完整展商数组，在浏览器内执行搜索、精确筛选、分页和跨页选择。
- `admin-users-panel.tsx` 通过 TanStack Query 调用 `/api/admin/users`。后端支持 `page` 和 `pageSize`，但组件当前固定请求第 1 页、20 条。
- 两个组件的布局不同：展商使用原生 `<table>` 加移动端卡片；用户列表使用适配响应式 CSS 的 `div/article` ARIA table。
- 本任务不创建通用 DataTable 组件。两套数据源和渲染结构差异较大，共享抽象会增加条件分支而不能减少领域代码。
- 本任务不新增排序。展商当前没有排序交互；用户接口也没有排序参数。对单个服务端分页结果做客户端排序会产生错误语义。
- 保留既有 CSS 类名、按钮文案、ARIA label、对话框和业务回调。

## 方案

### 展商看板：客户端表格模型

为展商数据建立一个受控 `useReactTable` 实例：

- `getRowId` 使用现有 `boothRecordKey`，保证选择状态不依赖数组下标。
- `getCoreRowModel` 提供基础行模型。
- `getFilteredRowModel` 接管搜索、位置、类型、分配状态和成员筛选。
- `getPaginationRowModel` 接管分页切片和页数计算。
- `rowSelection` 作为 TanStack Table 的受控状态，替换 `Set<string>`。
- 表头“选择当前页全部展商”使用 page-row selection API，只影响当前页。
- 批量操作从 selected row model 读取完整展商记录。
- 原生表格和移动端卡片都渲染 `table.getRowModel().rows`，避免两套分页数据源。

筛选控件继续保留领域友好的状态和值；它们被映射到 TanStack Table 的 `globalFilter` 和 `columnFilters`。筛选变化由表格自动回到第一页。编辑展商导致稳定 ID 变化时，显式迁移对应的 selection key，维持现有行为。

表格列定义保持模块级稳定。TanStack Table 负责生成过滤、分页和选择后的 row model；桌面表格与移动端卡片继续用领域化 JSX 渲染 `row.original`，从而保留现有语义结构和复杂业务回调，而不为纯展示额外包装通用单元格组件。

### 后台用户列表：服务端受控分页

为用户列表建立 `manualPagination` 表格实例：

- 分页状态采用 TanStack Table 的零基 `PaginationState`。
- 请求 URL 将 `pageIndex + 1` 和 `pageSize` 传给现有 API。
- Query key 包含已应用筛选和分页状态，避免跨页缓存串用。
- `rowCount` 使用 API 返回的 `total`，由 Table 计算页数。
- `getRowId` 使用 `personId`。
- 筛选提交与清除筛选时重置到第 1 页。
- 列表渲染改为遍历 Table row/cell model，并继续输出现有 `role="table"`、`role="row"`、`role="cell"` 结构。
- 增加最小分页导航：上一页、当前页/总页数、下一页；沿用现有按钮样式，不改变列表卡片 CSS。

用户数据仍由服务端负责筛选。Table 不启用客户端过滤或排序，避免仅在当前页二次处理。

### 数据更新与错误处理

- 用户新增、编辑、启停、删除和导入成功后继续失效 `queryKeys.admin.users.all`。
- 如果删除最后一页的最后一条记录导致当前页越界，组件将分页状态夹到新的最后一页，并触发正确页请求。
- 加载、空结果和错误文案保持现状；翻页期间允许 Query 保留上一页数据，避免列表闪空，同时通过 `aria-busy` 表示刷新状态。
- 展商批量修改、分配、停用和单项编辑继续直接更新本地 `booths` 状态；Table 从新数据重新构建行模型。

## 测试策略

遵循 TDD，先补行为测试并确认失败：

1. 后台用户点击下一页会请求 `page=2&pageSize=20`，渲染第二页数据。
2. 后台用户在第二页提交或清除筛选后回到 `page=1`。
3. 展商当前页全选只选择当前页，翻页后选择数保留，第二页不被误选。
4. 既有展商筛选、分页、编辑、批量操作、焦点和 ARIA 测试继续通过。

验证顺序：相关组件测试、TypeScript/构建、全测试套件、`npm audit`。审计漏洞数不得高于基线。

## 明确不做

- 不抽取通用 DataTable。
- 不增加客户端或服务端排序。
- 不改变现有视觉设计或 CSS 布局。
- 不改动用户 API、仓储或数据库查询协议；复用现有 `page/pageSize` 能力。
- 不迁移对话框、数据获取或业务 mutation；这些已由前序任务处理。
