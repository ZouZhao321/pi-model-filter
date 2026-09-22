# 交接：model-filter 扩展（pi-model-filter）

生成时间：2026-09-23。给下一个 agent 承接本插件的工作。

远端仓库：https://github.com/ZouZhao321/pi-model-filter

## 这个插件做什么

每次会话启动时做三层过滤，把结果注册给 `opencode-go`：

1. 向 opencode 接口 `GET {baseUrl}/models` 要一份当前凭据可用的模型 id。这份数据只有 id，没有任何参数。
2. 到 pi 那份列表里取元数据，取不到的 id 丢弃。
3. 套排除清单，删掉清单里列出的模型。

请求是异步的，不挡住会话启动：启动时先用上次保存的名单注册一份，请求成功后写入新名单并重新注册，失败则沿用已注册的那份并写一条日志。

请求带重试，策略照抄 pi 自己的 `fetchWithRetry`：同一个超时预算（10 秒）内最多尝试 3 次，可重试的状态码为 408、425、429、500、502、503、504，传输错误也重试，两次尝试之间不等待。

名单来源（外部环境）隔离在 `AvailableModelsSource` 接口后面，默认实现 `createOpencodeGoSource` 走 opencode 接口，`refresh` 接收来源工厂，换数据源只改这一处。

配置与数据都在 `~/.pi/agent/model-filter/`：

- `model-exclude.json` —— 排除清单，格式 `{ "provider 名": ["模型 id"] }`，按完整 id 精确匹配。
- `available-models.json` —— 上一次接口返回的 id 名单，结构 `{ provider, updatedAt, ids }`。
- `requests.log` —— 请求日志，每行一条 JSON，字段 `at`、`provider`、`url`、`outcome`、`durationMs`、`attempts`、`status`、`idCount`、`error`。

配置或名单文件不合法时就地抛出错误。

## 为什么必须用扩展实现

`models.json` 对模型是 upsert 语义（`dist/core/provider-composer.js` 的 `applyModelsJson`：先整份复制内置模型，再按 id 覆盖或追加），没有删除入口。扩展的 `registerProvider` 在提供 `models` 时是替换语义（同文件 `applyExtension`：`config.models` 存在时直接 map 返回，不保留原有条目），这是唯一能真正减少模型列表的方式。

时机必须挂在 `session_start`：factory 阶段拿到的内置目录不完整，另有一批模型是运行期从远端目录刷新的，到 `session_start` 才齐。会话启动之后调用 `registerProvider` 是立即生效的（pi 文档写明不需要 `/reload`），所以异步请求返回之后可以再注册一次。

## 当前清单状态（2026-09-23）

`opencode-go` 排除 16 条：

```
deepseek-v4-flash, deepseek-v4-flash-vision-exp, deepseek-v4-pro, deepseek-v4.1-flash,
glm-5.3, gpt-5.6-luna, grok-4.5, grok-4.6, grok-4.7, hy4-preview, kimi-k3,
mimo-v2.5-pro, mimo-v2.6-pro, qwen3.7-max, qwen3.8-flash, qwen3.8-max
```

其中 15 条来自月度限额表（限额低于 $60），`grok-4.5` 是 pi 内置数据里残留、远端目录已经下线的模型。

会话里最终显示 15 个：`glm-5.1`、`glm-5.2`、`glm-5.3-flash`、`hy3`、`kimi-k2.6`、`kimi-k2.7-code`、`longcat-2.0`、`mimo-v2.5`、`mimo-v2.6-flash`、`minimax-m2.7`、`minimax-m3`、`muse-spark-1.2-contributor`、`muse-spark-1.3-contributor`、`qwen3.6-plus`、`qwen3.7-plus`。

限额表来源：`https://opencode.ai/docs/go/` 的 Usage limits 表。限额机制是 5 小时窗口 = 月限的 20%，每周 = 50%，每月 = 100%。

## issue #1 与实现规格

- issue #1：https://github.com/ZouZhao321/pi-model-filter/issues/1
- 实现规格：仓库根目录的 `SPEC.md`。

issue 里五个待决问题的结论：pi 那边查不到参数的模型一律丢弃、不补参数；请求失败沿用上次保存的名单并记日志；每次 `session_start` 都发请求、异步进行、结果保存到插件目录；只处理 `opencode-go`；与 pi.dev 目录的关系是取交集，元数据以 pi.dev 为准。

## 关键实测事实（2026-09-23）

- 接口 `GET https://opencode.ai/zen/go/v1/models` 返回 33 个 id，字段只有 `id`、`object`、`created`、`owned_by`。
- pi 那份列表有 31 个：pi.dev 远端目录缓存 30 个，加上只在 pi 内置数据里存在的 `grok-4.5`。
- 排除清单 16 条里 15 条命中接口返回的 id，会话里最终显示 15 个。
- 接口返回但 pi 列表里没有的 id 会被丢弃。`deepseek-flash`、`minimax-m2.5`、`omen-alpha` 三个就属于这一类，pi.dev 收录之前不会出现在列表里。
- **`x-opencode-session` 请求头是必须的**。缺它时接口返回 HTTP 400 `MissingSessionID`，与调用的模型无关。pi 自己会带上这个头（`x-opencode-session` 加 `x-opencode-client: pi`）。
- **同一个 provider 下模型的 `baseUrl` 会随接口类型不同**：opencode-go 的 `anthropic-messages` 模型用 `https://opencode.ai/zen/go`，`openai-completions` 模型用 `https://opencode.ai/zen/go/v1`。模型列表接口属于 OpenAI 兼容端点，插件取 `openai-completions` 模型的地址再拼 `/models`。改用第一个模型的地址会拼出 `/zen/go/models`，接口返回 404。
- provider 级别没有 `baseUrl`，`provider.baseUrl` 是 undefined，地址挂在模型条目上。
- `pi --list-models` 不走会话流程，不受过滤影响，看到的是未过滤的完整列表。
- pi.dev 远端目录的条目带完整参数，包括价格（`cost` 的四个字段）、上下文长度、输出上限、输入类型、是否支持思考与兼容开关。pi.dev 收录一个模型之后，插件不需要给它补任何参数。

## 验证方式

探针扩展在 `~/.pi/tmp/probe-filter.ts`（`~/.pi/tmp/` 已被 gitignore），每 500 毫秒采样一次 opencode-go 的模型 id，写入 `~/.pi/tmp/probe-filter.json`。

```bash
cd ~/.pi
rm -f tmp/probe-filter.json
pi -ne -nc -ns -np -nt -p "只回答 ok" --no-session \
   -e "C:/Users/ZouZhao/.pi/agent/extensions/model-filter" \
   -e "C:/Users/ZouZhao/.pi/tmp/probe-filter.ts"
cat agent/model-filter/requests.log
```

已经实测通过的路径：首次运行（启动瞬间是 pi 的完整列表，请求返回后变成 15 个）、第二次启动（启动瞬间就是 15 个）、离线启动（不发请求、不写日志，列表仍是 15 个）、请求失败（列表保持 15 个，日志记一条 `failure`，`attempts` 为 3）。

失败注入的办法：临时给 `~/.pi/agent/models.json` 的 `opencode-go` 加一个指向无效地址的 `baseUrl`，跑完删掉。

## 开发约定

```bash
npm install
npm run lint        # eslint
npm run format      # prettier
npm run typecheck   # tsc --noEmit
npm run test        # vitest
```

改完清单后 `/reload` 或重启 pi 生效。插件目录支持 `/reload` 热重载。

## 文件地图

- `index.ts` —— 插件入口。`parseModelIds()` 响应解析、`selectModels()` 三层过滤、`fetchWithRetry()` 重试都是纯函数；`createOpencodeGoSource()` 是默认的名单来源，`refresh()` 负责编排（取名单、写文件、重新注册、记日志），`loadExcludes()` 读清单，`loadAvailableIds()` 与 `saveAvailableIds()` 读写名单，`appendLog()` 写日志，`applyFilter()` 计算并注册。
- `index.test.ts` —— 上述纯函数的单元测试，15 个用例。
- `SPEC.md` —— 实现规格。
- `~/.pi/agent/model-filter/model-exclude.json` —— 排除清单（被 `~/.pi` 仓库跟踪）。
- `~/.pi/agent/model-filter/available-models.json` —— 上一次接口返回的 id 名单（运行时数据，已被忽略）。
- `~/.pi/agent/model-filter/requests.log` —— 请求日志（运行时数据，已被忽略）。
- `~/.pi/agent/models.json` —— provider 配置，`opencode-go` 下现在只有 `modelOverrides`（四个模型补图片输入）。
- `~/.pi/agent/models-store.json` —— pi 的模型目录缓存。
- `~/.pi/tmp/probe-filter.ts` —— 端到端验证用的探针扩展。
