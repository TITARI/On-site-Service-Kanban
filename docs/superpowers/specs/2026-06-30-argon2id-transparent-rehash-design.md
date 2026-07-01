# Argon2id 透明密码升级设计

## 背景

当前 `password-service.ts` 为所有新密码生成固定参数 `scrypt$16384$8$1$...`。该配置低于 OWASP 当前建议的 scrypt 最低成本，而且自定义字符串与硬编码验证器让算法迁移必须一次性替换全部凭据。项目需要让新密码立即使用 Argon2id，并在管理员下一次成功登录时把旧 scrypt hash 无感升级。

OWASP 推荐优先使用 Argon2id，并给出 `m=19456 KiB, t=2, p=1` 作为最低等价配置之一。`@node-rs/argon2` 生成标准 PHC 字符串，算法、版本和成本参数随 hash 自描述。当前 npm 最新稳定版为 `2.0.2`。

## 已批准方案

采用专用 compare-and-swap repository 操作：

```ts
upgradeAdminPasswordHash(
  accountId: string,
  expectedHash: string,
  replacementHash: string
): Promise<boolean>
```

该操作只在数据库当前 hash 仍等于 `expectedHash` 时替换为 `replacementHash`。它不修改 `passwordChangedAt`、`mustChangePassword`、失败次数、锁定状态、账号版本或业务审计，也不复用具有“管理员重置密码”语义的 `setUserPassword`。

## 密码服务

### 新 hash

`hashPassword` 保留既有输入约束：至少 10 个 JavaScript 字符且 UTF-8 编码不超过 1024 字节。通过后调用 `@node-rs/argon2`：

- algorithm: Argon2id
- memoryCost: 19456 KiB
- timeCost: 2
- parallelism: 1

输出必须是以 `$argon2id$` 开头的 PHC 字符串。盐由库为每次调用随机生成。

`@node-rs/argon2@2.0.2` 将 `Algorithm` 声明为 ambient `const enum`，与项目的 `isolatedModules` 类型检查不兼容。实现使用该枚举的运行时 Argon2id 值 `2 as Algorithm`，并用 PHC 参数测试和生产构建同时校验算法选择。

### 验证路由

`verifyPassword` 先执行 1024 字节上限保护，然后按明确前缀分派：

- `$argon2id$`：交给 `@node-rs/argon2.verify`；密码不匹配或 PHC 格式非法返回 `false`。
- `scrypt$`：进入保留的严格 legacy verifier，只接受项目历史生成的 `16384/8/1`、16 字节 canonical base64url salt 和 64 字节 key。
- 其他前缀：直接返回 `false`，不尝试昂贵运算。

旧 scrypt verifier 继续使用 `timingSafeEqual`，并保留“合法 hash 遇到 scrypt 运行故障时抛出”的既有行为，以区分密码错误和基础设施故障。

`needsRehash` 在本任务中只对 `scrypt$` 返回 `true`。其他未知格式无法通过验证；当前参数生成的 Argon2id 不重复 rehash。未来提高 Argon2 参数时可以基于 PHC 参数扩展该函数，而无需改变存储格式。

## 登录数据流

管理员密码验证成功后：

1. 正常调用 `recordAdminLoginSuccess`，保持既有失败计数和登录审计语义。
2. 若 `needsRehash(storedHash)`：
   - 用本次已验证的明文密码生成 Argon2id hash；
   - 调用 `upgradeAdminPasswordHash(accountId, storedHash, replacementHash)`；
   - 返回 `true` 时记录不含密码/hash 的 `console.info`；
   - 返回 `false` 表示并发期间 hash 已变化，静默跳过；
   - hash 或写库抛错时 `console.warn`，但不改变登录成功结果。
3. 继续创建管理员会话并返回成功。

CAS 防止两个并发登录互相覆盖，也防止透明升级覆盖用户在验证后立即设置的新密码。升级必须 await；不使用“发后即忘”的后台 Promise，因为 serverless 请求结束后后台任务不保证完成。

## 存储实现

### JSON 文件存储

在现有原子 `updateState` 内查找 `accountCredentials`。账号不存在时抛出与其他 credential 操作一致的错误；hash 不匹配返回 `false`；匹配时仅替换 `passwordHash` 并返回 `true`。

### MariaDB

执行单条条件更新：

```sql
UPDATE account_credentials
SET password_hash = ?
WHERE account_id = ? AND password_hash = ?
```

`affectedRows === 1` 返回 `true`，否则返回 `false`。不写 audit row，且 SQL 参数和日志中不得暴露明文密码。

## 错误与安全边界

- 密码错误、未知 hash、非法 PHC 均 fail closed 为 `false`。
- 过长密码在进入 scrypt/Argon2 原生工作前拒绝，避免计算型 DoS。
- 旧 hash 验证通过前绝不生成新 hash，也绝不写库。
- 透明升级失败不阻塞登录，但正常的登录成功记录或会话创建失败仍保持现有失败语义。
- 日志只包含 `accountId` 和错误对象，不包含密码、旧 hash 或新 hash。
- `setUserPassword` 的显式改密流程自动改用新的 `hashPassword`，无需额外迁移逻辑。

## 测试策略

严格按 TDD 覆盖：

1. 密码服务：Argon2id PHC 参数、随机盐、正确/错误密码、最小/最大长度、非法 hash、真实旧 scrypt 验证、`needsRehash`。
2. 文件状态：CAS 成功、预期 hash 不匹配、不改变密码元数据或 audit。
3. MariaDB：条件 SQL、参数顺序、affectedRows 返回值、不写 audit。
4. auth service：旧 hash 成功登录后升级；Argon2id 不升级；错误密码不升级；CAS 写入失败仅告警且会话仍成功。
5. 既有 API、用户管理、文件存储和 MariaDB 测试无回归。

## 文件范围

- `package.json`, `package-lock.json`
- `src/lib/services/password-service.ts`
- `src/lib/services/auth-service.ts`
- `src/lib/services/access-state-service.ts`
- `src/lib/repositories/app-repository.ts`
- `src/lib/db/mariadb-access-store.ts`
- `src/lib/db/mariadb-state-store.ts`
- 对应 password/auth/repository/MariaDB/API 测试

设计与计划文档和实现组成一个 commit、一个 PR。不会批量重算现有 hash，不修改数据库 schema，也不引入密码 pepper 或新的后台任务系统。
