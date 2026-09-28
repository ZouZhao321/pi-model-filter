# 领域文档

工程 skill 在探索代码库时如何消费本仓库的领域文档。

## 探索之前先读这些

- 仓库根的 **`CONTEXT.md`**，或者
- 仓库根的 **`CONTEXT-MAP.md`**（如果存在）：它指向每个上下文各自的 `CONTEXT.md`。读与当前话题相关的那些。
- **`docs/adr/`**：读与你即将改动的区域相关的决策记录。多上下文仓库还要看 `src/<context>/docs/adr/`。

如果这些文件不存在，**静默继续**。不要指出它们缺失，也不要主动建议创建。`/domain-modeling` skill（经由 `/grill-with-docs` 与 `/improve-codebase-architecture` 到达）会在术语或决策真正定下来时按需创建它们。

## 文件结构

单上下文仓库（大多数仓库）：

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

多上下文仓库（仓库根有 `CONTEXT-MAP.md`）：

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← 系统级决策
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← 上下文级决策
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## 用术语表的词汇

当你的输出提到某个领域概念（issue 标题、重构提案、假设、测试名）时，用 `CONTEXT.md` 里定义的词。不要漂到术语表明确避开的同义词上。

如果你需要的概念还不在术语表里，这是一个信号：要么你在发明项目不用的语言（重新考虑），要么真的缺一个词（记下来交给 `/domain-modeling`）。

## 指出决策记录的冲突

如果你的输出与已有的 ADR 矛盾，明确指出来，而不是默默覆盖：

> _与 ADR-0007（事件溯源的订单）冲突，但值得重新讨论，因为……_
