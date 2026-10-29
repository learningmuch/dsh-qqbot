/**
 * 斜杠命令注册中心
 *
 * 每个命令拆分为独立文件，此处仅编排。工厂函数注入依赖，统一导出命令列表。
 *
 * 命令按 category 分两类：
 *   - agent：底层 dsh agent 通用能力 + 宿主会话绑定（new/reset/compact/model/preset/list/use/watch/search/stop）
 *   - qqbot：插件自身特有（ping/version/status/help）
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { resetCommand, compactCommand } from './session.ts';
import { modelCommand } from './model.ts';
import { presetCommand } from './preset.ts';
import { statusCommand } from './status.ts';
import { helpCommand } from './help.ts';
import { pingCommand, versionCommand, stopCommand } from './misc.ts';
import {
  listCommand,
  listAllCommand,
  useCommand,
  currentCommand,
  unuseCommand,
  newSessionCommand,
  sessionStatusCommand,
  watchCommand,
  unwatchCommand,
  searchCommand,
  summaryCommand,
} from './bridge.ts';

/**
 * 构建标准命令列表
 */
export function buildCommandList(deps: CommandDeps): CategorizedCommand[] {
  const commands: CategorizedCommand[] = [
    // 通用能力（底层 agent）
    resetCommand(deps),
    compactCommand(deps),
    modelCommand(deps),
    presetCommand(deps),
    // 宿主会话绑定（/list /list-all /use /current /unuse /new /status /watch /unwatch /search）
    listCommand(deps),
    listAllCommand(deps),
    useCommand(deps),
    currentCommand(deps),
    unuseCommand(deps),
    newSessionCommand(deps),
    sessionStatusCommand(deps),
    watchCommand(deps),
    unwatchCommand(deps),
    searchCommand(deps),
    summaryCommand(deps),
    stopCommand(deps),
    // QQBot 特有
    pingCommand(),
    versionCommand(deps),
    statusCommand(deps),
  ];

  // help 需要访问完整列表（含自身），通过闭包惰性引用
  commands.push(helpCommand(deps, () => commands));

  return commands;
}
