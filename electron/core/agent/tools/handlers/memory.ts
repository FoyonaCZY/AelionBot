import { randomUUID } from 'node:crypto';
import type { Integrations } from '../../../extensions/integrations';
import { searchSkills } from '../../../extensions/skill-library';
import { assertMemoryOwner, humanRunSource } from '../../../memory/memory-routing';
import { unregisteredTool, type ToolContext, type ToolHandler } from '../context';
import { memorySafe, requiredText } from '../validation';

/** Skill tools backed by the discovered skill library; without integrations they are not registered. */
const withIntegrations =
  (handler: (context: ToolContext, integrations: Integrations) => unknown): ToolHandler =>
  (context) => {
    if (!context.deps.integrations) throw unregisteredTool(context.name);
    return handler(context, context.deps.integrations);
  };

export const MEMORY_HANDLERS: Record<string, ToolHandler> = {
  history_search: ({ bot, args, deps }) => {
    if (!deps.cognition) throw new Error('历史检索尚未启用');
    return deps.cognition.storage.search(bot.id, requiredText(args, 'query', 300), Number(args.limit) || 8);
  },
  history_read: ({ bot, args, deps }) => {
    if (!deps.cognition) throw new Error('历史检索尚未启用');
    return deps.cognition.storage.readHistory(
      bot.id,
      requiredText(args, 'messageId', 100),
      Number(args.before) || 0,
      Number(args.after) || 0,
    );
  },
  memory: ({ bot, args, runId, options, deps }) => {
    if (deps.cognition) return deps.cognition.memory.apply(bot.id, runId, args as any);
    if (options.peerOrigin) throw new Error('私聊记忆需要已核验的用户委托');
    const source = humanRunSource(deps.store, runId);
    if (source) assertMemoryOwner(deps.store, bot.id, source);
    const text = requiredText(args, 'content', 600);
    memorySafe(text);
    if (args.action === 'add') {
      if (!bot.memories.includes(text)) {
        if (bot.memories.join('\n').length + text.length > 2200) throw new Error('记忆容量已满，请先删除过时条目');
        bot.memories.push(text);
      }
    } else if (args.action === 'remove') bot.memories = bot.memories.filter((value) => value !== text);
    else throw new Error('未知记忆操作');
    deps.store.save();
    return { memories: bot.memories };
  },
};

export const SKILL_HANDLERS: Record<string, ToolHandler> = {
  skills_list: ({ bot, args, deps }) => {
    if (deps.integrations) {
      return deps.integrations.skills
        .search(
          bot.id,
          typeof args.query === 'string' ? args.query : '',
          Number(args.limit) || 100,
          Number(args.offset) || 0,
        )
        .map(({ body: _body, ...metadata }) => metadata);
    }
    return searchSkills(
      deps.store.data.skills.filter((s) => !s.botId || s.botId === bot.id),
      typeof args.query === 'string' ? args.query : '',
      Number(args.limit) || 100,
      Number(args.offset) || 0,
    ).map(({ id, name, description }) => ({ id, name, description }));
  },
  skill_read: ({ bot, args, runId, deps }) => {
    if (deps.integrations) {
      const skill = deps.integrations.skills.read(bot.id, requiredText(args, 'id', 160));
      const loaded = deps.preparedContext(runId)?.some((m) => {
        if (m.role !== 'tool') return false;
        try {
          const result = JSON.parse(m.content || '').result;
          return result?.id === skill.id && result.hash === skill.hash && result.body === skill.body;
        } catch {
          return false;
        }
      });
      if (loaded)
        return {
          id: skill.id,
          hash: skill.hash,
          alreadyLoaded: true,
          note: '相同版本的完整正文已在当前上下文中，无需重复载入。',
        };
      deps.integrations.skills.observeRead(bot.id, skill.id);
      return skill;
    }
    const id = requiredText(args, 'id', 150);
    const visible = deps.store.data.skills.filter((s) => !s.botId || s.botId === bot.id);
    const exact = visible.find((s) => s.id === id);
    if (exact) return exact;
    const named = visible.filter((s) => s.name === id);
    if (named.length > 1) throw new Error('存在多个同名技能，请用 skills_list 返回的 ID 读取');
    if (!named.length) throw new Error('技能不存在或无权访问，请先调用 skills_list 获取可用 ID');
    return named[0];
  },
  skill_patch: withIntegrations(({ bot, args, runId }, integrations) =>
    integrations.skills.patch(
      bot.id,
      requiredText(args, 'id', 160),
      requiredText(args, 'oldText', 8000),
      typeof args.newText === 'string' ? args.newText : '',
      requiredText(args, 'expectedHash', 128),
      runId,
    ),
  ),
  skill_file_write: withIntegrations(({ bot, args }, integrations) =>
    integrations.skills.writeResource(
      bot.id,
      requiredText(args, 'id', 160),
      requiredText(args, 'path', 500),
      requiredText(args, 'content', 128000),
      typeof args.expectedHash === 'string' ? args.expectedHash : undefined,
    ),
  ),
  skill_manage: withIntegrations(({ bot, args }, integrations) =>
    integrations.skills.manage(
      bot.id,
      requiredText(args, 'id', 160),
      requiredText(args, 'action', 50),
      typeof args.revision === 'number' ? args.revision : undefined,
    ),
  ),
  skill_file_read: withIntegrations(({ bot, args }, integrations) =>
    integrations.skills.readFile(bot.id, requiredText(args, 'id', 160), requiredText(args, 'path', 500)),
  ),
  skill_materialize: withIntegrations(({ bot, args, deps }, integrations) =>
    integrations.materialize(deps.vm, bot.id, requiredText(args, 'id', 160)),
  ),
  skill_save: ({ bot, args, runId, deps }) => {
    const skillName = requiredText(args, 'name', 80),
      description = requiredText(args, 'description', 400),
      body = requiredText(args, 'body', 8000);
    memorySafe(body);
    if (deps.integrations) {
      const saved = deps.cognition
        ? deps.cognition.saveSkill(
            bot.id,
            runId,
            skillName,
            description,
            body,
            Array.isArray(args.sourceRefs) ? args.sourceRefs : undefined,
          )
        : deps.integrations.skills.save(bot.id, skillName, description, body, { sourceRunId: runId });
      deps.changed();
      return saved;
    }
    const existing = deps.store.data.skills.find((s) => s.botId === bot.id && s.name === skillName);
    if (existing) {
      existing.description = description;
      existing.body = body;
    } else deps.store.data.skills.push({ id: randomUUID(), name: skillName, description, body, botId: bot.id });
    deps.store.save();
    return {
      saved: true,
      id: deps.store.data.skills.find((s) => s.botId === bot.id && s.name === skillName)!.id,
      name: skillName,
      scope: 'bot-private',
    };
  },
};
