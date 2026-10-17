/**
 * assets 层共享 git 基础设施。
 *
 * 背景：资产层存在两类 git 仓库 ——
 *   1. `<assetsDir>/skills`：独立 git 仓库（skill 自有进化历史）；
 *   2. `<assetsDir>`：外层 git 仓库（strategies / programs / tasks 等资产共用，
 *      `.gitignore` 中排除 `skills/`，避免形成 gitlink / 嵌入式仓库语义）。
 *
 * 两个模块都需要「以 `node:child_process` 调 git + 显式注入作者身份」这一层，
 * 故抽到本叶子模块，保持**单一实现**，避免 skills / assets 相互反向导入。
 *
 * 设计约束：
 *   - 不新增第三方依赖，仅 `node:child_process`；
 *   - 不依赖宿主机全局 git config：以 `-c user.name/user.email` 显式提供身份，
 *     并同时设置 `GIT_AUTHOR_*` / `GIT_COMMITTER_*` 环境变量双保险；
 *   - 固定 `-c core.autocrlf=false`：资产正文必须**逐字节保真**（验收 AC2）。
 *     若宿主机配置 `core.autocrlf=input/true`，git add 会把 CRLF 规范化为 LF，
 *     导致 `git show` 回读的正文与写入原文不再逐字节一致。
 *   - 本模块只提供「执行器 + 身份 + init 基元」，不含任何业务语义。
 */
import { execFileSync } from 'node:child_process'

/** git 作者身份：显式提供，避免依赖宿主机全局 git config。 */
export const GIT_IDENTITY_NAME = 'dsh-ia'
export const GIT_IDENTITY_EMAIL = 'dsh-ia@localhost'

/**
 * git 命令执行器：执行 `git <args>`（cwd 指定工作目录），成功返回 stdout 文本，
 * 失败（非零退出 / 可执行文件缺失）抛错。可注入以便单测模拟 git 不可用。
 */
export type GitRunner = (args: string[], cwd: string) => string

/** 默认 git 执行器：`execFileSync` 调 `git`，显式注入作者身份。 */
export function defaultGitRunner(args: string[], cwd: string): string {
  return execFileSync(
    'git',
    [
      '-c',
      `user.name=${GIT_IDENTITY_NAME}`,
      '-c',
      `user.email=${GIT_IDENTITY_EMAIL}`,
      // 字节保真：禁止 CRLF→LF 的入库规范化，也不在 checkout 时改写行尾。
      '-c',
      'core.autocrlf=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // 双保险：即便 `-c` 被上层覆盖，commit 仍带显式作者/提交者身份。
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: GIT_IDENTITY_NAME,
        GIT_AUTHOR_EMAIL: GIT_IDENTITY_EMAIL,
        GIT_COMMITTER_NAME: GIT_IDENTITY_NAME,
        GIT_COMMITTER_EMAIL: GIT_IDENTITY_EMAIL,
      },
    },
  )
}

/** 初始化 git 仓库（默认分支 main）；`-b` 不被支持时回落到普通 `git init`。 */
export function initGitRepo(dir: string, run: GitRunner): void {
  try {
    run(['init', '-b', 'main'], dir)
  } catch {
    // 老版本 git 不支持 `-b`：回落普通 init（分支名用仓库默认）。
    run(['init'], dir)
  }
}
