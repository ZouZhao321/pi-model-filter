// 隔离工作区（.worktrees/）属于另一条分支的工作副本，不参与主仓库的测试扫描。
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/.worktrees/**'],
  },
});
