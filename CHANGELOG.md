# Changelog

所有重要的版本变更都会记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/)。

## [Unreleased]

## [0.1.0] - 2026-09-21

### Added

- `session_start` 时按 `providers.json` 的声明重建每个 provider 的模型列表，先用上一次的目录缓存注册一份，再在后台刷新
- 用 `registerProvider` 的整体替换语义删掉内置模型，`models.json` 只有 upsert 语义，删不掉既有条目
- provider 声明可以写 `source` 引用另一条声明，引用方与被引用方共用一次请求与一份缓存，只有 `name` 能各自覆盖
- 目录来源 `http-model-list`：按 `fields` 把响应字段映射成 `id`、`name`、`contextWindow` 与 `endpoints`，响应封装按 `openai-data-array` 取 `data` 数组
- 目录请求按声明组装：`url` 里的 `{baseUrl}` 用声明的 `baseUrl` 替换，`requestHeaders` 支持 `{"generator": "uuid"}` 每次请求生成新值，`authHeader` 为 `bearer` 时带上该 provider 的凭据
- 元数据来源两种：`pi-model-list` 复用 pi 自己抓取的模型列表，`npm-package-doc` 从官方 npm 包的 markdown 表格解析 `id`、`name`、`contextWindow`、思考档位与价格
- 排除清单 `model-exclude.json`，按完整模型 id 精确匹配，不支持通配符
- 参数补充表 `model-extras.json`，`maxTokens` 与 `input` 只在元数据与默认值都给不出时补，其余字段一律覆盖上游数据
- 默认值 `maxTokens` 为 16384、`input` 为 `["text"]`、`contextWindow` 为 0、价格全为 0，元数据里有思考档位时 `reasoning` 为 true
- 只保留 `endpoints` 里含 `/chat/completions` 的模型
- 请求超时 10 秒、最多尝试 3 次且两次尝试之间不等待，重试 408、425、429、500、502、503、504 与传输错误
- `PI_OFFLINE` 跳过所有请求，会话只用已缓存的列表
- 目录与元数据缓存分别写入 `catalog-<provider>.json` 与 `metadata-<provider>.json`，下一次会话启动时先注册这份缓存
- 刷新失败时沿用已注册的列表，并向 `requests.log` 追加一行 JSON 记录
- 会话结束之后才回来的响应仍然更新缓存与日志，但不再调用注册接口
- `requests.log` 每行一个 JSON 对象，记 `at`、`provider`、`url`、`outcome`、`durationMs` 与尝试次数，成功时另有模型数与 `pendingExtras`，失败时另有状态码与错误原因
- 以 npm 包 `pi-model-filter` 发布，`pi.extensions` 声明入口 `./src/index.ts`，打 `v*` 标签触发带 provenance 的发布工作流
