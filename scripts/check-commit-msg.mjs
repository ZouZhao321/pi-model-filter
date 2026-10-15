// 校验提交信息是否符合仓库约定：`type(scope): 中文描述`。
// 由 husky 的 commit-msg 钩子调用，git 会把提交信息文件的路径作为第一个参数传入；
// CI 的 commit-msg job 也用同一个脚本校验推送区间里的每条提交标题。
// 自动生成的提交（合并、回退、rebase 的 fixup）不走这套约定，按前缀直接放行。
import { readFileSync } from 'node:fs';

const TYPES = ['feat', 'fix', 'refactor', 'test', 'docs', 'chore', 'perf'];
const SKIP_PREFIXES = ['Merge ', 'Revert ', 'fixup! ', 'squash! ', 'amend! '];
const SUBJECT = /^([a-z]+)(?:\(([^()]+)\))?: (.+)$/;
const HAN = /[\u4e00-\u9fff]/;

// 标题是第一行既非空也非注释的行：那个文件里还带着模板说明与 git 生成的注释
function subjectLine(text) {
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped && !stripped.startsWith('#')) return stripped;
  }
  return '';
}

// 没有参数说明不是被 git 或 CI 调起来的，没有东西可校验
const file = process.argv[2];
if (!file) process.exit(0);

const subject = subjectLine(readFileSync(file, 'utf8'));
if (!subject) {
  console.error('提交信息为空');
  process.exit(1);
}
if (SKIP_PREFIXES.some((prefix) => subject.startsWith(prefix))) process.exit(0);

const matched = SUBJECT.exec(subject);
if (!matched) {
  console.error(`提交信息不符合 \`type(scope): 中文描述\` 格式：${subject}`);
  process.exit(1);
}
const [, type, , desc] = matched;
if (!TYPES.includes(type)) {
  console.error(`type 必须是 ${TYPES.join('/')} 之一，当前是：${type}`);
  process.exit(1);
}
if (!HAN.test(desc)) {
  console.error(`描述必须包含中文：${desc}`);
  process.exit(1);
}
