# 贡献指南

感谢你对本项目的关注！以下是参与贡献的流程。

## 开发流程

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feat/你的功能名`
3. 提交代码：遵循 [Conventional Commits](#commit-规范) 规范
4. 推送分支：`git push origin feat/你的功能名`
5. 创建 Pull Request

## Commit 规范

使用 [Conventional Commits](https://www.conventionalcommits.org/) 格式：

```
<type>(<scope>): <description>

[optional body]
```

### Type 类型

| Type | 说明 |
|------|------|
| feat | 新功能 |
| fix | Bug 修复 |
| docs | 文档变更 |
| style | 代码格式（不影响逻辑） |
| refactor | 重构 |
| test | 测试相关 |
| chore | 杂项 |

### 示例

```bash
feat(auth): 新增登录功能
fix(api): 修复分页查询问题
docs: 更新 README
```

## PR 要求

- 标题描述清晰
- 关联相关 Issue（如有）
- 自测通过
- 一次 PR 只做一件事

## 问题反馈

使用 [Issue Tracker](../../issues) 提交问题或建议。
