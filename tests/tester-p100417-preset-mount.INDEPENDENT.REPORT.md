# P100417 测试报告：固定会话 investment-advisor 工具补全修复

- **被测交付物**：`/Users/reachlucifer/project/opc/dsh-ia`（未 commit，工作树）
- **改动文件**：`src/session-ensure.ts`、`src/plugin.ts`、`tests/session-ensure.test.ts`
- **根因**：dsh 工具「按 scope 归属可见」，dsh-base 的 read/write/edit/bash 工具挂在 agent preset 的 standing mount 上，必须 `agentPresets.mount(agentCtx, preset.id)` 挂到 agent scope 才可见。
- **测试结论：5/5 验收标准全部通过 ✅**

---

## 逐条验收核验

### AC1 ✅ 全新环境首启后固定会话可调用 read/write/edit/bash 等 base 工具
**通过**。
- 证据（运行时语义，非 tsc）：已核对 harness 源码，确认修复正确复刻了唯一正确模式。
  1. `packages/bundle/web-app/cordis.patch.yml` L565 `default: standard` — 默认 preset 是 `standard`。
  2. `packages/bundle/web-app/presets/standard.patch.yml` — `standard` preset 的 `plugins` 含 `tool-bash`（bash）、`tool-fs`（read/write/edit）、`tool-fs-search`、`tool-skill` 等，即 base 工具由 preset 提供。
  3. `packages/preset/agent-preset-registry/src/mount.ts` — `mountPreset` 把 preset 的 plugins 组成 standing mount（`tree`），工具挂在 preset scope。
  4. `packages/preset/agent-preset-registry/src/index.ts` `mount()`→`bind()`→`join()` 调用 `bindScopeParent(key, generation.key)`，把 agent scope 父链挂到 preset 的 standing mount scope。
  5. `packages/core/tools/src/index.ts` — 工具按 `dsh-scope` 的 scoped layer 注册，只有 scope 被 parent 到 preset mount 的 agent 才能看到这些工具。
- 修复点：`session-ensure.ts` 的 `create` 分支写 `meta: { agentPreset: defaultId }` 并挂 `setup`，`setup` 内 `agentPresets.mount(agentCtx, presetId)`，与 harness `createWebhookSession`（`packages/webhook/webhook/src/session.ts`）**逐字同构**。

### AC2 ✅ 固定会话可调用 dsh-ia 自注册的全部 21 个工具
**通过**。
- 自注册工具（14 模型工具 + 7 task_* 工具）经 `ctx.tools.register` 在 `plugins.ts` 的 `apply` 内注册，挂到 plugin ctx scope，不受 preset mount 影响；本改动不改动工具注册路径，`resolveAgentOptions`/`agentOptions` 投影也保持原样。
- 证据：本次改动对 `src/plugin.ts` 仅新增两行 export（`mountDefaultPresetSetup`、`AgentPresetsLike`），未触碰工具/SKILL 注册逻辑；`pnpm test` 中 `tester-task10-task-authorship`（断言 ctx.skills 恰注册 6 个）与 `plugin-tools-registration.spec.ts` 全绿。

### AC3 ✅ 重启后（resume）工具仍齐全
**通过**。
- 证据：源码 `resume` 分支同样展开 `...(mountSetup === undefined ? {} : { setup: mountSetup })`，即恢复分支也挂了 mount setup。
- 独立验证测试（新增 `tester-p100417-preset-mount.INDEPENDENT.spec.ts` 第 1 条）断言：`applySessionEnsure` 走 resume 分支时，`setup` 被注入且调用时 `agentPresets.mount(fakeAgentCtx, 'standard')` 被精确调用一次。

### AC4 ✅ agentPresets 不可用时插件仍能装载不崩溃
**通过**。
- 证据：
  1. `applySessionEnsure` 对 `agentPresets` 用「软取」（`ctx.get` 包 try/catch，失败 → `undefined`），不加入顶层 `inject`（契约仍固定三项）。
  2. `mountDefaultPresetSetup`：`agentPresets` 缺失 / `mount` 非函数 → 返回 `undefined`，不挂 `setup`、不设 `meta.agentPreset`。
  3. `mount` 抛错时在 setup 内 try/catch 记日志、不向上抛。
- 独立测试第 3/4/5 条全部断言通过（`applySessionEnsure` 缺失 preset 不 crash、mount 抛错仍 created、`mountDefaultPresetSetup` 边界返回 undefined）。

### AC5 ✅ pnpm test 全绿、pnpm build 通过
**通过**。
- `pnpm test`：**47 files / 940 tests passed**（935 原有 + 5 新增独立测试）。
- `pnpm build`：clean + `tsc --noEmit` + `tsc` server + copy-assets 全部无错。
- `pnpm typecheck`：exit 0。

---

## 工具可见性运行时语义的验证方式（非 tsc）

1. **源码级对齐**：逐行比对 harness `createWebhookSession`（已知唯一正确会话创建路径）与 `session-ensure.ts` 的 `create`/`resume` 分支，确认三者对 `meta.agentPreset` + `setup` 内 `ctx.agentPresets.mount(agentCtx, presetId)` 的处理完全一致。
2. **scope 语义确认**：阅读 `agent-preset-registry` 的 `mount`/`bind`/`join`/`bindScopeParent`、`mount.ts` 的 `mountPreset`/`standingMountFor`、`core/tools` 的 scoped layer 注册，确认「工具按 scope 可见」这一运行时契约，以及 `mount` 是唯一把 base 工具暴露给 agent scope 的机制。
3. **默认 preset 溯源**：确认 `defaultId = 'standard'`，且 `standard` preset 的 plugins 确实包含 `tool-bash`/`tool-fs`（read/write/edit/bash）。
4. **独立对抗测试**：新增 `tests/tester-p100417-preset-mount.INDEPENDENT.spec.ts`（5 条），在 `applySessionEnsure` 接线层验证 create 与 resume 两分支都注入 `setup` 且 `setup` 精确调用 `mount(agentCtx, defaultId)`；也验证了降级分支（preset 缺失 / mount 抛错）不崩溃、不设 setup/meta。

> **局限说明**：未在完整 dsh harness 宿主（真实 `agentPresets`/`dsh-scope` 服务树）里跑端到端装载，因为 `agentPresets` 服务依赖完整的 profile 组合器（`dsh-scope` + preset registry + Loader），在插件单元仓库内无法独立拉起。故工具「真实可见」这一环通过源码级契约对齐 + 独立 mock 验证「mount 被正确调用且参数正确」来闭环，而非仅靠 tsc 类型通过。

---

## 测试产物
- 新增独立测试：`tests/tester-p100417-preset-mount.INDEPENDENT.spec.ts`（5 个用例，全绿）。

## 风险点 / 建议
- ⚠️ **低风险**：`mount` 抛错时降级只记日志，base 工具会缺失（读/写/编辑/bash 不可用），但符合「不限制工具」约束下的保守降级语义——preset 不可用属宿主环境异常，当前处理合理。若希望 base 工具缺失时暴露更明显告警，可在 opening-notice 或日志级别上调。
- ⚠️ **观察项**：`defaultId` 为空字符串时仍会写 `meta.agentPreset: ''` 并挂 setup → mount 会因 `Unknown agent preset` 抛错并降级。当前行为正确（不崩溃），但边界上 preset id 为空属于配置错误，建议在宿主层兜底。