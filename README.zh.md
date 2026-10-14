[English](./README.md)

# Model Filter Extension

> 按 `model-exclude.json` 的排除清单，从会话的模型列表里剔除指定模型。

## 机制

- 配置格式：provider 名 -> 模型 id 模式数组，元素支持 `*` 通配符：

```json
{
  "opencode-go": ["grok-4.5", "muse-spark-*"]
}
```

- 挂钩 `session_start` 过滤：factory 阶段内置模型目录不完整，还有一批模型运行期才从远端刷新，`session_start` 时列表才齐。
- 用 `registerProvider` 的整体替换语义实现删除——`models.json` 是 upsert 语义，没有删除入口。

## 开发

```bash
npm install
npm run lint        # eslint
npm run format      # prettier
npm run typecheck   # tsc --noEmit
npm run test        # vitest
```
