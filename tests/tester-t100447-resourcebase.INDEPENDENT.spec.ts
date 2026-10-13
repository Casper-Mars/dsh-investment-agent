/**
 * tester 独立验证 —— t100447「为 2 个固件 skill 补齐 resourceBase」。
 *
 * 被测交付物：`src/skills/index.ts` 的 `buildIntrinsicSkillRegistration` 新增
 *   `resourceBase: { kind: 'directory', path: resolveIntrinsicSkillDir(frontmatter.name) }`，
 *   其中 `resolveIntrinsicSkillDir(name) = fileURLToPath(new URL('./<name>/', import.meta.url))`。
 *
 * 本文件由 Tester 独立自建，不读取 / 不依赖 Developer 的任何 spec 断言，也不复用其用例。
 * 只用被测函数返回值的**语义断言**（basename / existsSync / isDirectory / isAbsolute /
 * 目录骨架），不硬编码整串路径（宿主机路径会因机器而异）。
 *
 * 覆盖两条链路：
 *   - 源码态：`import` `../src/skills/index.js`（.js 指向 .ts，vitest 解析）
 *   - 编译态：`await import('../dist-server/skills/index.js')`
 *
 * 对抗性：断言 path 结尾不含 `SKILL.md`（印证「目录」而非「文件」）。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute } from 'node:path'

import {
  createIntrinsicSkillRegistration,
  createSkillAuthorshipRegistration,
  TASK_AUTHORSHIP_SKILL_NAME,
  SKILL_AUTHORSHIP_SKILL_NAME,
} from '../src/skills/index.js'

/** 编译态模块类型（与源码态同源接口，结构一致）。 */
type IntrinsicSkillModule = typeof import('../src/skills/index.js')

/** 一个 register 对象的资源基断言（源码态 / 编译态共用）。 */
function assertResourceBaseSemantics(
  reg: { resourceBase?: { kind?: string; path: string }; name: string },
  expectedName: string,
  expectParentGrandparent: { parent: string; grandparent: string },
) {
  // AC1：resourceBase 存在且 kind === 'directory'
  expect(reg.resourceBase, 'resourceBase 应存在').toBeDefined()
  expect(reg.resourceBase?.kind, 'resourceBase.kind 应为 directory').toBe('directory')

  const p = reg.resourceBase!.path
  // AC2：绝对路径
  expect(isAbsolute(p), `path 应为绝对路径，实际: ${p}`).toBe(true)
  // AC2 对抗性：不指向 SKILL.md 文件
  expect(
    /SKILL\.md/i.test(basename(p)),
    `path 不应以 SKILL.md 结尾，实际: ${p}`,
  ).toBe(false)
  // AC2：basename === skill 名
  expect(basename(p), `path basename 应等于 skill 名，实际: ${p}`).toBe(expectedName)

  // AC3：磁盘真实存在且是目录
  expect(existsSync(p), `path 应真实存在，实际: ${p}`).toBe(true)
  expect(statSync(p).isDirectory(), `path 应为目录，实际: ${p}`).toBe(true)

  // AC4：目录骨架 parent === 'skills'，grandparent 区分源码态/编译态
  expect(basename(dirname(p)), `path 父目录应为 skills，实际: ${p}`).toBe(
    expectParentGrandparent.parent,
  )
  expect(
    basename(dirname(dirname(p))),
    `本轮应指向 ${expectParentGrandparent.grandparent}，实际: ${p}`,
  ).toBe(expectParentGrandparent.grandparent)
}

describe('t100447 —— 固件 skill resourceBase（源码态）', () => {
  it('AC1/AC2/AC3/AC4：createIntrinsicSkillRegistration()=task-authorship 资源基正确', () => {
    const reg = createIntrinsicSkillRegistration()
    assertResourceBaseSemantics(reg, TASK_AUTHORSHIP_SKILL_NAME, {
      parent: 'skills',
      grandparent: 'src',
    })
    // AC4 印证：源码态盘上目录名与 SKILL.md 可解析
    expect(existsSync(`${reg.resourceBase!.path}/SKILL.md`)).toBe(true)
  })

  it('AC2/AC5：createSkillAuthorshipRegistration()=skill-authorship 资源基正确', () => {
    const reg = createSkillAuthorshipRegistration()
    assertResourceBaseSemantics(reg, SKILL_AUTHORSHIP_SKILL_NAME, {
      parent: 'skills',
      grandparent: 'src',
    })
    expect(existsSync(`${reg.resourceBase!.path}/SKILL.md`)).toBe(true)
  })

  it('AC5：两处 resourceBase 语义一致（皆 directory、basename 匹配各自 name）', () => {
    const a = createIntrinsicSkillRegistration()
    const b = createSkillAuthorshipRegistration()
    expect(a.resourceBase!.kind).toBe('directory')
    expect(b.resourceBase!.kind).toBe('directory')
    expect(basename(a.resourceBase!.path)).toBe(TASK_AUTHORSHIP_SKILL_NAME)
    expect(basename(b.resourceBase!.path)).toBe(SKILL_AUTHORSHIP_SKILL_NAME)
    // 两个目录不同（各自独立）
    expect(a.resourceBase!.path).not.toBe(b.resourceBase!.path)
  })

  it('AC6：其余契约字段不受影响', () => {
    for (const [name, reg] of [
      [TASK_AUTHORSHIP_SKILL_NAME, createIntrinsicSkillRegistration()],
      [SKILL_AUTHORSHIP_SKILL_NAME, createSkillAuthorshipRegistration()],
    ] as const) {
      expect(reg.name, `${name}.name`).toBe(name)
      expect(typeof reg.description, `${name}.description 应为字符串`).toBe('string')
      expect(reg.description.length, `${name}.description 非空`).toBeGreaterThan(0)
      expect(reg.source, `${name}.source 应为 runtime`).toBe('runtime')
      expect(reg.invocation, `${name}.invocation 应存在`).toBeDefined()
      expect(reg.invocation.modelInvocable, `${name} 模型侧调用`).toBe(true)
      expect(reg.invocation.userInvocable, `${name} 用户侧调用`).toBe(true)
      expect(typeof reg.content, `${name}.content 应为字符串`).toBe('string')
      expect(reg.content.length, `${name}.content 非空`).toBeGreaterThan(0)
    }
  })
})

describe('t100447 —— 固件 skill resourceBase（编译态 dist-server）', () => {
  it('AC4：编译态 path 形如 …/dist-server/skills/<name>/', async () => {
    const dist = (await import('../dist-server/skills/index.js')) as IntrinsicSkillModule

    const task = dist.createIntrinsicSkillRegistration()
    assertResourceBaseSemantics(task, TASK_AUTHORSHIP_SKILL_NAME, {
      parent: 'skills',
      grandparent: 'dist-server',
    })
    expect(existsSync(`${task.resourceBase!.path}/SKILL.md`)).toBe(true)

    const skill = dist.createSkillAuthorshipRegistration()
    assertResourceBaseSemantics(skill, SKILL_AUTHORSHIP_SKILL_NAME, {
      parent: 'skills',
      grandparent: 'dist-server',
    })
    expect(existsSync(`${skill.resourceBase!.path}/SKILL.md`)).toBe(true)
  })
})