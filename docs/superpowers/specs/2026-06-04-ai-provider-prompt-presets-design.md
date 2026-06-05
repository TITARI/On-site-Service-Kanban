# AI 接口与提示词预设设计

## 背景

当前后台“AI 接口”配置只提供两组模型的基础字段：供应商、接口地址、模型名称、密钥环境变量、超时时间和启用状态。这个模式对熟悉 OpenAI 兼容接口的人可用，但对现场后台管理员不够友好：不知道该填哪个供应商地址、模型名称、环境变量，也没有明确提示 AI 在系统里实际承担哪些调用场景。

本次设计将后台 AI 设置升级为市面上常见的“供应商预设 + 高级配置”模式，并增加“AI 调用预设 / 提示词模板”。用户已确认采用“预设可复制后编辑”：内置模板不可直接修改，管理员可复制为自定义模板后调整。

## 目标

- 让管理员能通过供应商预设快速配置常见模型接入。
- 明确系统内 AI 的调用场景：工单分类、相似工单判重、超时研判。
- 给每个调用场景提供内置提示词预设，避免从空白 prompt 开始。
- 允许复制内置预设生成自定义模板，再编辑、测试并设为默认。
- 保持现有 AI 调用链稳定，避免提示词误改直接破坏自动建单。

## 非目标

- 本轮不接入新的多模型路由引擎，只扩展现有 `fast` 与 `smart` 模型配置和场景提示词配置。
- 本轮不做复杂审批、版本发布流或权限分级。
- 本轮不做在线拉取供应商模型列表，模型名称先使用预设推荐加手动输入。
- 本轮不改变 AI 返回 JSON 的核心契约。

## 设计概览

后台 AI 设置分为两个区域：

1. 模型接入
   - 每个模型仍保留“快速 AI”和“高智能 AI”两张配置卡。
   - 新增供应商预设选择：DeepSeek、OpenAI、通义千问、Kimi、智谱、自定义。
   - 选择供应商后在界面上提示默认 Base URL、推荐模型名、API Key 环境变量名和适合的超时时间。
   - 保留高级字段：接口地址、模型名称、密钥环境变量、超时毫秒、启用开关。

2. AI 调用预设
   - 三个场景：工单分类、相似工单判重、超时研判。
   - 每个场景展示当前使用的模板。
   - 内置模板只读，操作为“复制为自定义”。
   - 自定义模板可编辑名称、系统提示词、说明、启用状态，并可设为该场景默认。
   - 提供“恢复内置预设”入口。

## 数据模型

扩展 `AppConfig`：

```ts
type AiProviderPresetId = "deepseek" | "openai" | "qwen" | "kimi" | "zhipu" | "custom";

type AiPromptScenario = "classify" | "dedupe" | "escalation";

type AiPromptTemplate = {
  id: string;
  scenario: AiPromptScenario;
  name: string;
  description: string;
  systemPrompt: string;
  builtIn: boolean;
  enabled: boolean;
  updatedAt?: string;
};

type AiPromptDefaults = Record<AiPromptScenario, string>;
```

在 `AiModelConfig` 上新增可选字段：

```ts
providerPreset?: AiProviderPresetId;
```

在 `AppConfig` 上新增可选字段：

```ts
aiPromptTemplates?: AiPromptTemplate[];
aiPromptDefaults?: Partial<AiPromptDefaults>;
```

旧配置没有这些字段时，系统使用内置供应商提示和内置 prompt 模板，不需要迁移即可运行。

## 供应商预设

内置供应商提示：

- DeepSeek
  - Base URL: `https://api.deepseek.com/v1/chat/completions`
  - 推荐模型：`deepseek-chat`
  - API Key 环境变量：`DEEPSEEK_API_KEY`
  - 默认超时：8000ms
- OpenAI
  - Base URL: `https://api.openai.com/v1/chat/completions`
  - 推荐模型：`gpt-4o-mini`
  - API Key 环境变量：`OPENAI_API_KEY`
  - 默认超时：8000ms
- 通义千问
  - Base URL: `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`
  - 推荐模型：`qwen-plus`
  - API Key 环境变量：`DASHSCOPE_API_KEY`
  - 默认超时：10000ms
- Kimi
  - Base URL: `https://api.moonshot.cn/v1/chat/completions`
  - 推荐模型：`moonshot-v1-8k`
  - API Key 环境变量：`MOONSHOT_API_KEY`
  - 默认超时：10000ms
- 智谱
  - Base URL: `https://open.bigmodel.cn/api/paas/v4/chat/completions`
  - 推荐模型：`glm-4-flash`
  - API Key 环境变量：`ZHIPU_API_KEY`
  - 默认超时：10000ms
- 自定义
  - 不自动覆盖字段，只显示 OpenAI 兼容接口填写提示。

这些值作为后台表单提示和一键填充，不强制覆盖用户已有配置。

## 提示词预设

内置三类模板：

1. 工单分类
   - 输入：展位号、现场描述、可用问题类型。
   - 输出：`{"issueType":"问题类型","confidence":0到1}`。
   - 要求模型只返回 JSON。

2. 相似工单判重
   - 输入：展位号、现场描述、候选未关闭工单。
   - 输出：`{"confidence":0到1,"matchedTicketId":"可选工单ID"}`。
   - 用于决定是新建工单还是催单。

3. 超时研判
   - 输入：展位号、现场描述、相似工单和催单信息。
   - 输出：`{"confidence":0到1,"suggestion":"处理建议","matchedTicketId":"可选工单ID"}`。
   - 用于给管理员升级建议。

内置模板不能直接编辑。复制为自定义模板时，系统创建一个 `builtIn: false` 的模板，默认名称为“内置模板名 - 自定义”，管理员可编辑并设为默认。

## 调用流程

AI 调用时按场景读取模板：

1. 读取 `config.aiPromptDefaults[scenario]` 指向的模板。
2. 如果默认模板缺失或禁用，回退到该场景内置模板。
3. 将模板的 `systemPrompt` 传入 HTTP AI provider。
4. 保持现有用户消息 payload 与 JSON 解析逻辑。
5. HTTP 调用失败时继续走现有 mock fallback。

## 后台交互

AI 接口卡片：

- 供应商使用下拉选择。
- 旁边展示当前供应商的“推荐填法”提示。
- 提供“应用推荐值”按钮，把推荐 Base URL、模型名、API Key 环境变量、超时写入表单。
- 保存按钮仍保存单个模型配置。

AI 调用预设卡片：

- 每个场景一张卡：当前模板、模板来源、描述、启用状态。
- 内置模板显示“复制为自定义”。
- 自定义模板显示“编辑”“设为默认”“恢复内置预设”。
- 编辑区包含模板名称、系统提示词、说明。
- 保存前做基本校验：名称非空、提示词非空、场景有效。

## 错误处理

- 模型名称或超时时间无效时，沿用现有 toast 提示。
- 自定义模板缺少名称或提示词时，显示 toast：`请填写模板名称和系统提示词`。
- 默认模板被禁用或删除时，调用层回退到内置模板，后台显示“当前默认已回退到内置预设”。
- 自定义提示词不会自动保证 JSON 正确，界面提示必须保留“请保持 JSON 输出字段约束”。

## 测试计划

- 单元测试供应商预设 helper：不同供应商返回正确推荐字段。
- 单元测试 prompt 模板 helper：默认模板解析、自定义模板回退、复制模板。
- HTTP AI provider 测试：使用配置模板传入 system prompt。
- 后台组件测试：
  - 渲染供应商预设、应用推荐值并保存。
  - 渲染三类 AI 调用预设。
  - 复制内置模板为自定义模板。
  - 编辑自定义模板并设为默认。
- 全量测试确保既有工单、微信、后台功能不回归。

## 自查

- 范围聚焦在后台 AI 接口与提示词预设，没有引入无关模型路由重构。
- 旧配置可以无迁移运行，缺失字段均可回退到内置预设。
- 内置模板不可直接编辑，符合用户确认的“预设可复制后编辑”。
- 三个场景覆盖当前代码实际调用：`classify`、`dedupe`、`escalation`。
