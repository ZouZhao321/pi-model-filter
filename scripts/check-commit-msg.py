# 校验提交信息是否符合仓库约定：`type(scope): 中文描述`。
# 由 .pre-commit-config.yaml 里的 commit-msg hook 调用，git 会把提交信息文件的路径当第一个参数传进来。
# 自动生成的提交（合并、回退、rebase 的 fixup）不走这套约定，按前缀直接放行。
import re
import sys
from pathlib import Path

TYPES = ("feat", "fix", "refactor", "test", "docs", "chore", "perf")
SKIP_PREFIXES = ("Merge ", "Revert ", "fixup! ", "squash! ", "amend! ")
SUBJECT = re.compile(r"^(?P<type>[a-z]+)(?:\((?P<scope>[^()]+)\))?: (?P<desc>.+)$")
HAN = re.compile(r"[\u4e00-\u9fff]")


def subject_line(text: str) -> str:
    # 标题是第一行既非空也非注释的行：那个文件里还带着模板说明与 git 生成的注释
    for line in text.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            return stripped
    return ""


def main(argv) -> int:
    # 没有参数说明不是被 git 调起来的（例如手敲命令时漏了文件），没有东西可校验
    if not argv:
        return 0

    message = Path(argv[0]).read_text(encoding="utf-8")
    subject = subject_line(message)
    if not subject:
        print("提交信息为空", file=sys.stderr)
        return 1
    if subject.startswith(SKIP_PREFIXES):
        return 0

    matched = SUBJECT.match(subject)
    if not matched:
        print(f"提交信息不符合 `type(scope): 中文描述` 格式：{subject}", file=sys.stderr)
        return 1
    if matched["type"] not in TYPES:
        print(f"type 必须是 {'/'.join(TYPES)} 之一，当前是：{matched['type']}", file=sys.stderr)
        return 1
    if not HAN.search(matched["desc"]):
        print(f"描述必须包含中文：{matched['desc']}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
