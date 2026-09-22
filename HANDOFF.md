# 交接：model-filter 扩展（pi-model-filter）

生成时间：2026-09-22。给下一个 agent 承接本插件的工作。

远端仓库：https://github.com/ZouZhao321/pi-model-filter

## 这个插件做什么

在 `session_start` 时读 `~/.pi/agent/model-exclude.json`，按 provider 分组，把清单里列出的模型从该 provider 的模型列表中剔除，再用 `pi.registerProvider` 注册剩下的列表。

- 配置格式：`{ "provider 名": ["模型 id", "支持 * 通配符"] }`，例如 `{"opencode-go": ["glm-5.3", "muse-spark-*"]}`。
- 配置缺失、JSON 不合法、值不是字符串数组，一律直接抛出错误，不做兜底。
- 配置路径常量 `CONFIG_PATH` 写死在 `index.ts` 里，指向 `~/.pi/agent/model-exclude.json`。
- 插件本身不含任何模型 id，唯一出现模型 id 的位置是 `index.ts` 里配置格式的注释示例。

## 为什么必须用扩展实现

`models.json` 对模型是 upsert 语义（`dist/core/provider-composer.js` 的 `applyModelsJson`：先整份复制内置模型，再按 id 覆盖或追加），没有删除入口。扩展的 `registerProvider` 在提供 `models` 时是替换语义，这是唯一能真正减少模型列表的方式。

时机必须挂在 `session_start`：factory 阶段拿到的内置目录不完整（实测只有 19 个 opencode-go 模型），另有一批是运行期从远端目录刷新进来的，到 `session_start` 才齐。

## 当前清单状态（2026-09-22）

`opencode-go` 排除 16 条：

```
deepseek-v4-flash, deepseek-v4-flash-vision-exp, deepseek-v4-pro, deepseek-v4.1-flash,
glm-5.3, gpt-5.6-luna, grok-4.5, grok-4.6, grok-4.7, hy4-preview, kimi-k3,
mimo-v2.5-pro, mimo-v2.6-pro, qwen3.7-max, qwen3.8-flash, qwen3.8-max
```

其中 15 条来自月度限额表（限额低于 $60），`grok-4.5` 是表外模型（pi 内置目录里还残留，远端目录已下线），用户决定一并禁止。

保留 15 条（限额均为 $60）：`glm-5.1`、`glm-5.2`、`glm-5.3-flash`、`hy3`、`kimi-k2.6`、`kimi-k2.7-code`、`longcat-2.0`、`mimo-v2.5`、`mimo-v2.6-flash`、`minimax-m2.7`、`minimax-m3`、`muse-spark-1.2-contributor`、`muse-spark-1.3-contributor`、`qwen3.6-plus`、`qwen3.7-plus`。

限额表来源：`https://opencode.ai/docs/go/` 的 Usage limits 表。限额机制是 5 小时窗口 = 月限的 20%，每周 = 50%，每月 = 100%。

## 已建的远端与 issue

- GitHub 私有仓库 `ZouZhao321/pi-model-filter`，本地仓库的 `origin` 已指向它。
- **issue #1**：https://github.com/ZouZhao321/pi-model-filter/issues/1 —— 需求是让插件改用 `OPENCODE_API_KEY` 自动获取 opencode 的模型列表，再按排除清单剔除。issue 正文列了五个待决问题，评论里补了三个模型的实测结论。

## 待决问题（issue #1 正文里也有）

1. **元数据缺口**：`GET https://opencode.ai/zen/go/v1/models` 只返回 `id`/`object`/`created`/`owned_by`，没有任何元数据。pi 调用模型需要 `api`、`baseUrl`、`contextWindow`、`maxTokens`、`cost`、`input`、`reasoning`、`compat`。pi 数据源里查不到元数据的新模型（例如 `omen-alpha`），是跳过不注册，还是用默认值注册。
2. **接口调用失败时的行为**：网络不可用、key 无效、非 2xx 时，保持 pi 原有列表还是就地抛出。本仓库风格是就地抛出。
3. **刷新频率与缓存**：每次 `session_start` 都请求，还是加缓存与有效期限。`session_start` 是同步回调，网络请求要改成异步并考虑对启动速度的影响。
4. **provider 范围**：只处理 `opencode-go`，还是按 `model-exclude.json` 里的 provider 键逐个处理（`opencode` provider 用同一个 `OPENCODE_API_KEY`，接口路径不同）。
5. **与 pi.dev 目录的关系**：opencode 接口返回账户可用模型，pi.dev 目录返回 pi 上游收录的模型。最终列表取两者共有的部分还是合并。

## 关键实测事实（2026-09-22）

### 数据源机制

pi 里 `opencode-go` 的模型列表 = **pi-ai 内置快照**（`@earendil-works/pi-ai/dist/providers/data/opencode-go.json`，生成时间 2026-08-14）**+ pi.dev 远端目录**（`GET https://pi.dev/api/models/providers/opencode-go`），按 id 合并：同 id 用远端条目覆盖，内置没有的 id 追加。

- pi.dev 目录是公开端点，**不带任何凭据**，用 `if-none-match` 做协商。
- 刷新间隔 `REMOTE_CATALOG_REFRESH_INTERVAL_MS = 4 小时`，启动时触发，缓存写在 `~/.pi/agent/models-store.json`（结构 `{provider: {models, checkedAt, lastModified, etag}}`）。
- `PI_OFFLINE` 存在时只用缓存不联网。

### 三个模型的实际状态

opencode 接口返回 33 个 id，pi.dev 目录返回 30 个，差额是 `deepseek-flash`、`omen-alpha`、`minimax-m2.5`。这三个在 pi 里原本完全不可见。

按 `model-probe` skill 规范实测，三个全部可用（均返回 `PROBE_OK`）：

| 模型             | 状态 | 耗时 | token | 协议               |
| ---------------- | ---- | ---- | ----- | ------------------ |
| `deepseek-flash` | OK   | 4.2s | 3966  | openai-completions |
| `minimax-m2.5`   | OK   | 4.0s | 3703  | openai-completions |
| `omen-alpha`     | OK   | 4.6s | 4085  | openai-completions |

报告：`~/.pi/agent/skills/model-probe-workspace/model-probe-opencode-go-20260922-222616.md`

为了让 pi 认识这三个 id，已在 `~/.pi/agent/models.json` 的 `opencode-go` 下加了 `models` 数组（提交 `8d7b2a16`）：

- `deepseek-flash` 元数据照抄 `deepseek-v4.1-flash`（1M 上下文、384K 输出、thinkingFormat deepseek）。
- `minimax-m2.5` 元数据照抄 `minimax-m2.7`（204800 上下文、131072 输出），价格用 Go 页面的 M2.5 档（0.30/1.20/0.06/0.375）。
- `omen-alpha` 的 `contextWindow`(200000)、`maxTokens`(32000)、`cost`(全 0) **是估算值**，公开资料查不到真实值，拿到准确值要改。

### 坑

- **opencode Go 强制要求 `x-opencode-session` 请求头**。缺这个头时返回 HTTP 400 `MissingSessionID`，与模型无关。pi 自己会发这个头（`x-opencode-session` 加 `x-opencode-client: pi`），自行拼请求验证时要补上。
- `deepseek-flash` 是 DeepSeek 官方的规范模型名，与 `deepseek-v4.1-flash` 指向同一个模型（DeepSeek-V4.1-Flash）；`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 是已退役旧名，请求仍被接受但由 V4.1-Flash 承接。自动获取列表时要做同义 id 归一化，否则会出现两条指向同一模型的条目。
- `minimax-m2.5` 的 `/chat/completions` 与 `/messages` 都能返回 200。
- `pi --list-models` 不走会话流程，不受过滤影响，看到的是未过滤的完整列表。判断过滤结果要看 `session_start` 之后的状态。
- `omen-alpha` 是 opencode 的隐身模型，厂商归在 `unknown` 分类下（`https://opencode.ai/data/unknown/omen-alpha`），Context/Output/Release 全部 Unknown，但使用量排名靠前。这类模型不会出现在 Go 宣传页面。

## 验证方式

过滤生效的端到端验证：跑一次真实会话，在 `session_start` 时把 provider 的模型 id 列表写到文件。探针扩展与校验脚本在 `~/.pi/tmp/`（已被 gitignore）：

```bash
cd ~/.pi
rm -f tmp/probe-models-after.json
pi -ne -nc -ns -np -nt -p "只回答 ok" --no-session \
   -e "C:/Users/ZouZhao/.pi/agent/extensions/model-filter" \
   -e "C:/Users/ZouZhao/.pi/tmp/probe-models.ts"
node tmp/verify-model-exclude.mjs
```

`verify-model-exclude.mjs` 会把配置与月度限额表逐条对比，并断言真实会话里存活下来的模型正好是限额 $60 的那批。

探测单个模型：

```bash
python ~/.pi/agent/skills/model-probe/scripts/probe.py --provider opencode-go \
  --model deepseek-flash --model minimax-m2.5 --model omen-alpha \
  --report-dir ~/.pi/agent/skills/model-probe-workspace
```

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

- `index.ts` —— 插件入口，`loadExcludes()` 读配置，`matches()` 是通配符匹配的纯函数，`session_start` 回调做过滤与注册。
- `index.test.ts` —— `matches()` 的单元测试（精确匹配、`*` 通配符、正则元字符按字面处理）。
- `~/.pi/agent/model-exclude.json` —— 排除清单（被 `~/.pi` 仓库跟踪）。
- `~/.pi/agent/models.json` —— provider 配置，`opencode-go` 下有 `models`（三个补充模型）与 `modelOverrides`。
- `~/.pi/agent/models-store.json` —— pi 的模型目录缓存。
- `~/.pi/agent/skills/model-probe/` —— 探测 skill（`scripts/probe.py`）。
- `~/.pi/agent/skills/model-probe-workspace/` —— 探测报告与历史分析。
