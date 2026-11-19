import { AppError } from '../../../../../shared/errors';
import type { WidgetScope } from '../../../../../shared/types/widget-types';
import type { ToolContext, ToolHandler } from '../context';

function widgetScopeForContext({ bot, run, options }: ToolContext): WidgetScope {
  if (options.peerOrigin || run?.peerOrigin)
    throw new AppError('widget.unavailable', '当前私聊协作任务不支持固定小工具');
  const groupId = options.groupOrigin?.groupId || run?.groupOrigin?.groupId;
  if (groupId) return { kind: 'group', id: groupId };
  const sessionId = run?.sessionId || options.sessionId;
  return { kind: 'bot', id: bot.id, ...(sessionId ? { sessionId } : {}) };
}

export const WIDGET_HANDLERS: Record<string, ToolHandler> = {
  widgets_list: (context) => {
    if (!context.deps.pinnedWidgets) throw new AppError('widget.unavailable', '固定小工具服务尚未就绪');
    const scope = widgetScopeForContext(context);
    const widgets = context.deps.pinnedWidgets.list(scope).map(({ id, title, state, updatedAt }) => ({
      id,
      title,
      state,
      updatedAt,
    }));
    return { count: widgets.length, widgets };
  },
  widget_save: (context) => {
    if (!context.deps.pinnedWidgets) throw new AppError('widget.unavailable', '固定小工具服务尚未就绪');
    const scope = widgetScopeForContext(context);
    const { args } = context;
    const { widget, created } = context.deps.pinnedWidgets.saveFromAgent(scope, {
      id: args.id,
      title: args.title,
      html: args.html,
      state: args.state,
      mergeState: args.mergeState,
    });
    return {
      id: widget.id,
      title: widget.title,
      state: widget.state,
      updatedAt: widget.updatedAt,
      created,
    };
  },
};
