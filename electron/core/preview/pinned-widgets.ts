import { randomUUID } from 'node:crypto';
import { AppError } from '../../../shared/errors';
import {
  WIDGET_MAX_PER_SCOPE,
  isPlainObject,
  validateWidgetHtml,
  validateWidgetState,
  validateWidgetTitle,
  widgetInScope,
  widgetScopeKey,
  type PinWidgetInput,
  type PinnedWidget,
  type UpdatePinnedWidgetInput,
  type WidgetScope,
} from '../../../shared/types/widget-types';
import type { Store } from '../storage/store';

function normalizeScope(scope: unknown): WidgetScope {
  if (!isPlainObject(scope)) throw new AppError('widget.scope_invalid', '无效的会话范围');
  if (scope.kind === 'group') {
    if (typeof scope.id !== 'string' || !scope.id.trim() || scope.id.length > 100)
      throw new AppError('widget.scope_invalid', '无效的群聊 ID');
    return { kind: 'group', id: scope.id.trim() };
  }
  if (scope.kind === 'bot') {
    if (typeof scope.id !== 'string' || !scope.id.trim() || scope.id.length > 100)
      throw new AppError('widget.scope_invalid', '无效的 Bot ID');
    if (scope.sessionId !== undefined) {
      if (typeof scope.sessionId !== 'string' || !scope.sessionId.trim() || scope.sessionId.length > 100)
        throw new AppError('widget.scope_invalid', '无效的工作会话 ID');
      return { kind: 'bot', id: scope.id.trim(), sessionId: scope.sessionId.trim() };
    }
    return { kind: 'bot', id: scope.id.trim() };
  }
  throw new AppError('widget.scope_invalid', '无效的会话范围');
}

export class PinnedWidgets {
  constructor(
    private store: Store,
    private changed: () => void,
  ) {
    this.store.data.pinnedWidgets ||= [];
  }

  private assertScopeExists(scope: WidgetScope) {
    if (scope.kind === 'group') {
      if (!this.store.data.groups.some((group) => group.id === scope.id))
        throw new AppError('widget.scope_invalid', '群聊不存在');
      return;
    }
    if (!this.store.data.bots.some((bot) => bot.id === scope.id))
      throw new AppError('widget.scope_invalid', 'Bot 不存在');
    if (
      scope.sessionId &&
      !this.store.data.workSessions?.some((session) => session.id === scope.sessionId && session.botId === scope.id)
    )
      throw new AppError('widget.scope_invalid', '工作会话不存在');
  }

  private entries(): PinnedWidget[] {
    return (this.store.data.pinnedWidgets ||= []);
  }

  list(scope?: WidgetScope): PinnedWidget[] {
    const all = this.entries();
    if (!scope) return all;
    const normalized = normalizeScope(scope);
    return all.filter((widget) => widgetInScope(widget, normalized));
  }

  pin(input: PinWidgetInput): PinnedWidget {
    if (!isPlainObject(input)) throw new AppError('widget.invalid', '小工具参数无效');
    const scope = normalizeScope(input.scope);
    this.assertScopeExists(scope);
    const html = validateWidgetHtml(input.html);
    const state = validateWidgetState(input.state);
    const sourceMessageId =
      typeof input.sourceMessageId === 'string' && input.sourceMessageId.trim()
        ? input.sourceMessageId.trim().slice(0, 120)
        : undefined;
    const sourceIndex =
      sourceMessageId !== undefined && Number.isInteger(input.sourceIndex) && (input.sourceIndex as number) >= 0
        ? (input.sourceIndex as number)
        : sourceMessageId !== undefined
          ? 0
          : undefined;
    const now = new Date().toISOString();
    const list = this.entries();
    if (sourceMessageId !== undefined) {
      const existingIndex = list.findIndex(
        (widget) =>
          widgetInScope(widget, scope) &&
          widget.sourceMessageId === sourceMessageId &&
          (widget.sourceIndex ?? 0) === (sourceIndex ?? 0),
      );
      if (existingIndex >= 0) {
        const current = list[existingIndex];
        const title = input.title !== undefined ? validateWidgetTitle(input.title, html) : current.title;
        const updated: PinnedWidget = {
          ...current,
          title,
          html,
          state: input.state !== undefined ? state : current.state,
          updatedAt: now,
        };
        list[existingIndex] = updated;
        this.store.save();
        this.changed();
        return updated;
      }
    }
    const scopedCount = list.filter((widget) => widgetInScope(widget, scope)).length;
    if (scopedCount >= WIDGET_MAX_PER_SCOPE)
      throw new AppError('widget.limit_exceeded', `当前会话最多固定 ${WIDGET_MAX_PER_SCOPE} 个小工具`);
    const title = validateWidgetTitle(input.title, html);
    const created: PinnedWidget = {
      id: randomUUID(),
      scope,
      title,
      html,
      state,
      ...(sourceMessageId !== undefined ? { sourceMessageId, sourceIndex } : {}),
      createdAt: now,
      updatedAt: now,
    };
    list.push(created);
    this.store.save();
    this.changed();
    return created;
  }

  update(input: UpdatePinnedWidgetInput, restrictScope?: WidgetScope): PinnedWidget {
    if (!isPlainObject(input) || typeof input.id !== 'string' || !input.id.trim())
      throw new AppError('widget.not_found', '小工具不存在');
    const id = input.id.trim();
    const list = this.entries();
    const index = list.findIndex((widget) => widget.id === id);
    if (index < 0) throw new AppError('widget.not_found', '小工具不存在');
    const current = list[index];
    if (restrictScope && widgetScopeKey(current.scope) !== widgetScopeKey(normalizeScope(restrictScope)))
      throw new AppError('widget.not_found', '小工具不存在');
    const hasChange =
      input.title !== undefined || input.html !== undefined || input.state !== undefined || Boolean(input.resetState);
    if (!hasChange) throw new AppError('widget.update_empty', '没有需要更新的小工具字段');
    const html = input.html !== undefined ? validateWidgetHtml(input.html) : current.html;
    const title = input.title !== undefined ? validateWidgetTitle(input.title, html) : current.title;
    let state = current.state;
    if (input.resetState) state = {};
    else if (input.state !== undefined) {
      const next = validateWidgetState(input.state);
      state = input.mergeState ? validateWidgetState({ ...current.state, ...next }) : next;
    }
    const updated: PinnedWidget = {
      ...current,
      title,
      html,
      state,
      updatedAt: new Date().toISOString(),
    };
    list[index] = updated;
    this.store.save();
    this.changed();
    return updated;
  }

  unpin(id: string): void {
    if (typeof id !== 'string' || !id.trim()) throw new AppError('widget.not_found', '小工具不存在');
    const list = this.entries();
    const index = list.findIndex((widget) => widget.id === id.trim());
    if (index < 0) throw new AppError('widget.not_found', '小工具不存在');
    list.splice(index, 1);
    this.store.save();
    this.changed();
  }

  saveFromAgent(
    scope: WidgetScope,
    args: {
      id?: unknown;
      title?: unknown;
      html?: unknown;
      state?: unknown;
      mergeState?: unknown;
    },
  ): { widget: PinnedWidget; created: boolean } {
    const normalized = normalizeScope(scope);
    this.assertScopeExists(normalized);
    if (args.id !== undefined && args.id !== '') {
      if (typeof args.id !== 'string' || !args.id.trim()) throw new AppError('widget.not_found', '小工具不存在');
      const widget = this.update(
        {
          id: args.id.trim(),
          ...(args.title !== undefined ? { title: args.title as string } : {}),
          ...(args.html !== undefined ? { html: args.html as string } : {}),
          ...(args.state !== undefined ? { state: args.state as Record<string, unknown> } : {}),
          ...(args.mergeState === true ? { mergeState: true } : {}),
        },
        normalized,
      );
      return { widget, created: false };
    }
    const widget = this.pin({
      scope: normalized,
      ...(args.title !== undefined ? { title: args.title as string } : {}),
      html: args.html as string,
      ...(args.state !== undefined ? { state: args.state as Record<string, unknown> } : {}),
    });
    return { widget, created: true };
  }
}
