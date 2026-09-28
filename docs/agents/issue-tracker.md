# Issue tracker：GitHub

本仓库的 issue 与规格存在 GitHub Issues 里。所有操作走 `gh` CLI。

## 约定

- **新建 issue**：`gh issue create --title "..." --body "..."`。多行正文用 heredoc。
- **读 issue**：`gh issue view <number> --comments`，用 `jq` 过滤评论，并同时取标签。
- **列出 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，配合 `--label` 与 `--state` 过滤。
- **评论**：`gh issue comment <number> --body "..."`
- **打标签 / 去标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

在克隆里运行 `gh` 会自动推断仓库；也可以从 `git remote -v` 确认。

## 把 PR 当作 triage 入口

**PR 作为请求入口：否。**（如果这个仓库把外部 PR 当特性请求，把它改成 `yes`；`/triage` 会读这个标记。）

设为 `yes` 时，PR 走与 issue 相同的标签与状态，用对应的 `gh pr` 命令：

- **读 PR**：`gh pr view <number> --comments`，差异用 `gh pr diff <number>`。
- **列出待 triage 的外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，只保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR`、`NONE` 的条目（丢掉 `OWNER`／`MEMBER`／`COLLABORATOR`）。
- **评论 / 打标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label`／`--remove-label`、`gh pr close`。

GitHub 的 issue 与 PR 共用一套编号，所以裸写 `#42` 可能是两者之一：先用 `gh pr view 42` 解析，失败再回退到 `gh issue view 42`。

## 当 skill 说「发布到 issue tracker」

创建一个 GitHub issue。

## 当 skill 说「取回对应的 ticket」

运行 `gh issue view <number> --comments`。

## wayfinding 操作

供 `/wayfinder` 使用。**map** 是一个 issue，**child** issue 是它的 ticket。

- **Map**：单个 issue，标签 `wayfinder:map`，正文放 Notes / Decisions-so-far / Fog。`gh issue create --label wayfinder:map`。
- **Child ticket**：用 GitHub sub-issue 关联到 map。不支持 sub-issue 时，把 child 加进 map 正文的任务列表，并在 child 正文顶部写 `Part of #<map>`。标签：`wayfinder:<type>`（`research`／`prototype`／`grilling`／`task`）。认领后指派给驱动的开发者。
- **阻塞**：用 GitHub 原生的 issue 依赖关系，它是界面上可见的规范表示。用 `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>` 添加边，其中 `<blocker-db-id>` 是阻塞方的数字数据库 id（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，不是 `#number`，也不是 `node_id`）。GitHub 用 `issue_dependencies_summary.blocked_by` 报告当前开着的阻塞方。依赖关系不可用时，回退到 child 正文顶部的 `Blocked by: #<n>, #<n>`。所有阻塞方关闭时该 ticket 解锁。
- **前沿查询**：列出 map 的开着的 child，去掉有开着的阻塞方（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行里有开着的 issue）或已有指派人的条目；map 顺序里第一个胜出。
- **认领**：`gh issue edit <n> --add-assignee @me`，这是本次会话的第一次写入。
- **解决**：`gh issue comment <n> --body "<answer>"`，然后 `gh issue close <n>`，再把上下文指针追加到 map 的 Decisions-so-far。
