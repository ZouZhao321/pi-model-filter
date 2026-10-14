[English](./README.md)

# Model Filter Extension

> 按 `model-exclude.json` 的排除清单，从会话的模型列表里剔除指定模型。

## 安装

推荐从 npm 安装：

```bash
pi install npm:pi-model-filter
```

也可以直接从仓库安装：

```bash
pi install git:github.com/ZouZhao321/pi-model-filter
```

本地开发时改为按目录安装，例如克隆目录名为 `model-filter`：

```bash
pi install ./model-filter
```

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
