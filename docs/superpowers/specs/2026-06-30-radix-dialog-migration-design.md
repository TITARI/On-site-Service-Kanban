# Radix Dialog 对话框迁移设计

## 背景

当前展商看板和用户批量导入使用手写遮罩层与对话框。`exhibitor-dashboard.tsx` 只有详情 drawer 自己监听 Escape 并保存触发按钮引用，其他对话框没有统一的焦点约束、自动聚焦、Escape 关闭和关闭后焦点恢复。`admin-user-import.tsx` 同样只提供 `role="dialog"` 与 `aria-modal`，没有完整键盘焦点生命周期。

代码审计确认任务中的“6 个对话框”计数已经过时。批准范围 A 包含 8 个 modal surface：

1. 展商类型设置
2. 现场搭建成员分配（单个与批量复用同一对话框）
3. 导入差异数值确认
4. 展商详情 drawer
5. 编辑展商数据
6. 批量修改类型
7. 批量停用展商
8. 用户批量导入

## 目标

- 使用 `@radix-ui/react-dialog` 管理普通 modal 的 Portal、焦点约束、自动聚焦、Escape 关闭、关闭后焦点恢复和 ARIA 语义。
- 使用 `@radix-ui/react-alert-dialog` 管理“批量停用展商”破坏性确认，并默认聚焦取消操作。
- 保留现有业务 state、保存/取消回调、文字、按钮、表单和 CSS 视觉效果。
- 删除详情 drawer 的手写 `detailReturnFocusRef`、`setTimeout(...focus())` 和全局 Escape 监听。
- 用可重复执行的组件测试证明每个迁移 surface 的关闭与焦点行为。

## 非目标

- 不迁移 `ticket-detail.tsx` 的图片预览。该预览已经实现焦点约束、自动聚焦、Escape、方向键、焦点恢复、滑动、旋转和缩放；本任务替换它会扩大交互回归风险，但不会消除本任务描述的缺陷。
- 不迁移 `exhibitor-import-wizard.tsx`、`exhibition-project-selector.tsx` 或 `admin-users-panel.tsx` 的其他手写对话框；它们不在已批准范围 A 内。
- 不抽取全项目通用 Dialog 包装器，不修改业务数据结构，不改变 API 调用。
- 不重新设计对话框样式、动画或页面布局。

## 方案选择

### 采用：在现有组件中直接组合 Radix primitives

每个对话框继续由现有 state 控制，只将外层结构替换为 Radix Root、Portal、Overlay、Content、Title/Description 和 Close。各对话框的尺寸、内容和关闭时清理逻辑不同，直接组合能保留现有语义，并避免为八个差异明显的 surface 建立过早抽象。展商看板中的多个 Root 使用 `createDialogScope()` 隔离上下文，使页面任意位置的触发按钮都能绑定到正确对话框，嵌套编辑/成员分配也不会误用详情 drawer 的 Root。

### 未采用：建立统一业务 Dialog 包装器

统一包装器能减少少量 JSX，但会增加 `title`、`description`、drawer 布局、嵌套对话框、状态清理和 AlertDialog 的条件分支。当前没有稳定的公共接口，抽象收益不足。

### 未采用：一次迁移项目内所有手写对话框

全项目迁移会把图片预览、导入向导、项目选择器和身份换绑确认带入同一 PR，增加测试矩阵和视觉回归风险，也违背已批准的范围 A。

## 组件结构

### 普通 Dialog

普通 surface 使用受控 Root：

```tsx
<Dialog.Root open={open} onOpenChange={(nextOpen) => {
  if (!nextOpen) closeDialog();
}}>
  <Dialog.Portal>
    <div className="existing-layer-class">
      <Dialog.Overlay className="existing-scrim-class" />
      <Dialog.Content className="existing-panel-class">
        <Dialog.Title asChild>
          <h4>现有标题</h4>
        </Dialog.Title>
        <Dialog.Close asChild>
          <button type="button">关闭</button>
        </Dialog.Close>
        {/* 原有内容 */}
      </Dialog.Content>
    </div>
  </Dialog.Portal>
</Dialog.Root>
```

Overlay 不再伪装成可聚焦的空按钮。点击遮罩、按 Escape 或点击 Close 都由 Radix 触发同一个 `onOpenChange(false)`，再调用现有关闭函数。这样可以避免关闭逻辑重复执行。

### 详情 drawer

详情 drawer 使用 Dialog Content 保留 `exhibitor-detail-drawer` 类名和侧滑布局。其语义从 `role="complementary"` 升级为 modal `dialog`，隐藏的 Dialog Title 保留既有可访问名称“展商详情”，可见公司名仍是内容标题。Radix 会把焦点恢复到同一 Root 中的 `Dialog.Trigger`；由于详情按钮有桌面表格和移动卡片两套入口，组件只记录当前触发入口的稳定 id，并让该入口在打开期间成为真正的 Trigger，不再保存或手动聚焦 DOM ref。FocusScope 的关闭回调是异步的，测试用 `waitFor` 观察最终焦点。

drawer 内打开成员分配对话框时，两层 Root 可以同时保持打开。子对话框关闭后焦点回到 drawer 内触发按钮；drawer 的背景内容在子对话框打开期间仍不可交互。

### 批量停用 AlertDialog

批量停用使用 AlertDialog Root/Portal/Overlay/Content。现有取消按钮由 `AlertDialog.Cancel asChild` 包装，确认按钮由 `AlertDialog.Action asChild` 包装。AlertDialog 打开时优先聚焦取消按钮，遮罩点击不会误确认破坏性操作，Escape 仍可取消关闭。

### 用户批量导入

`AdminUsersPanel` 持有受控 Dialog Root，并用真实 `Dialog.Trigger` 包装“批量导入”按钮；`AdminUserImport` 作为其后代只渲染 Portal/Overlay/Content。这样 Escape、遮罩和 Close 都通过父层 `onOpenChange(false)` 卸载面板，Radix 仍能在关闭后找到触发按钮并恢复焦点。标题沿用“批量导入用户”；关闭图标是 DOM 中首个可交互元素，因此作为默认自动聚焦目标。导入步骤、busy 状态、文件选择与网络流程保持不变。

## 状态与关闭行为

- boolean state 使用 `open={state}`；对象 state 使用 `open={Boolean(state)}`。
- `onOpenChange(false)` 调用现有关闭函数，保留草稿清理行为，例如 `closeDiffDialog()` 清空 `diffDrafts`。
- 业务成功回调继续直接更新 state；Root 随 state 关闭并执行焦点恢复。
- 不增加手写 `onEscapeKeyDown`、`onOpenAutoFocus` 或 `onCloseAutoFocus`，除非测试证明某个现有表单需要覆盖 Radix 默认值。
- 不保留独立 scrim 点击 handler；outside interaction 由 Radix 统一处理。

## CSS 与 Portal

Radix 是 headless primitives。Portal 中保留原有 layer、scrim、drawer/panel 类名，因此现有固定定位、z-index、尺寸、响应式和滚动样式继续生效。若元素类型变化导致选择器失效，只做保持现有视觉所需的最小 CSS 调整，不引入新视觉设计。

Portal 会把内容挂载到 `document.body`。现有测试使用 Testing Library 的全局 `screen` 查询，可继续查到对话框；局部 `within(dialog)` 查询保持有效。

## 测试策略

严格按 TDD 增加行为测试，先观察旧实现失败，再迁移 JSX：

- 详情 drawer：打开后自动聚焦首个按钮；Tab 不逃逸；Escape 关闭；焦点回到打开详情的按钮。
- 六个展商对话框：逐一验证 Escape 关闭和触发按钮焦点恢复；为带表单的对话框验证自动聚焦位于 Content 内。
- 成员分配嵌套场景：从 drawer 打开后，关闭子对话框将焦点恢复到 drawer 内触发按钮，drawer 仍保持打开。
- 批量停用：角色为 `alertdialog`，打开后取消按钮获得焦点，Escape 关闭且不会执行停用。
- 用户批量导入：打开后焦点进入 dialog，Tab 不逃逸，Escape 调用 `onClose`，关闭后回到“批量导入”触发按钮。
- 保留所有既有业务测试，更新详情 drawer 与批量停用的角色断言。

重点测试文件：

- `tests/components/exhibitor-dashboard.test.tsx`
- `tests/components/admin-panel.test.tsx`
- `tests/components/admin-user-import.test.tsx`
- `src/components/admin-users-panel.tsx`（仅为用户导入提供 Root/Trigger；不迁移其中其他对话框）
- 必要时调整统一 jsdom 测试 setup，仅补齐 Radix 所需的缺失浏览器 API，不在生产代码中加入测试分支。

## 依赖与交付门禁

- 安装 `@radix-ui/react-dialog` 与 `@radix-ui/react-alert-dialog`，锁定安装时 npm registry 的最新稳定版本。
- 依赖改动仅限两个 Radix 包及其传递依赖。
- 完整运行 `npm run test:run`、`npm run build` 与 `npm audit`。
- 基线为 94 个测试文件、767 个测试和 3 个漏洞（2 moderate、1 high）；测试不得回归，审计数量不得增加。
- 设计、计划、依赖、实现和测试组成一个 commit，并创建一个 ready PR。
