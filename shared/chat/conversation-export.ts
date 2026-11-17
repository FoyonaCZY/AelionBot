// A conversation as a Markdown document: who said what and when, in the order the chat shows it. The work behind
// an answer (tool steps, progress notes) is one line unless the steps are asked for; reasoning is never exported.
import type { ChatMessage, RunRecord } from '../types/core';
import type { Attachment } from '../types/attachment-types';
import { firstDeliveries } from '../types/attachment-types';
import type { GroupMessage } from '../types/group-types';
import type { MessageReply } from './message-replies';
import { previewFeedbackDisplay } from '../preview/preview-feedback';
import { translate } from '../i18n';
import { conversationTimeline, readableContent, runPresentation, runSteps, toolDisplay } from './activity';
import { isEmptyGroupReply } from './group-empty-reply';
import { stripBlockPlacements } from './message-blocks';
import { groupReplyContent } from './message-envelope';
import { readableQuestionAnswer } from './question-answers';

interface ConversationExportOptions {
  /** The document's heading: the Bot, the Bot and its work session, or the group. */
  title: string;
  /** What the user is called. */
  userName: string;
  exportedAt: string;
  /** List every tool step and progress note instead of one line counting them. */
  steps?: boolean;
  /** Formats a message's time; local `YYYY-MM-DD HH:mm` by default. */
  formatTime?: (time: string) => string;
  /** Words the document's own labels in the reader's language; the active language by default. */
  translate?: typeof translate;
}

const two = (value: number) => String(value).padStart(2, '0');
function localTime(time: string) {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}
const oneLine = (text: string, limit: number) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > limit ? line.slice(0, limit) + '…' : line;
};
/** What the chat shows of a Bot's message: no tagged reasoning, no placement markers. */
const answerText = (content: string) => stripBlockPlacements(readableContent(content)).trim();
const quote = (text: string) =>
  text
    .split('\n')
    .map((line) => (line ? '> ' + line : '>'))
    .join('\n');

class Document {
  private readonly blocks: string[] = [];
  readonly time: (time: string) => string;
  readonly t: typeof translate;
  constructor(options: ConversationExportOptions, subtitle?: (t: typeof translate) => string) {
    this.time = options.formatTime || localTime;
    this.t = options.translate || translate;
    this.blocks.push('# ' + oneLine(options.title, 200));
    this.blocks.push(
      [subtitle?.(this.t), this.t('导出时间：{time}', { time: this.time(options.exportedAt) })]
        .filter(Boolean)
        .join('  \n'),
    );
  }
  add(block: string | undefined) {
    if (block?.trim()) this.blocks.push(block.trim());
  }
  /** `**Name** · time`, the line every message starts with. */
  speaker(name: string, time: string) {
    const stamp = this.time(time);
    this.blocks.push(`**${oneLine(name, 80).replace(/\*/g, '')}**` + (stamp ? ' · ' + stamp : ''));
  }
  said(input: { reply?: MessageReply; content: string; attachments?: Pick<Attachment, 'name'>[] }) {
    if (input.reply)
      this.add(
        quote(
          this.t('引用 {author}：{text}', {
            author: input.reply.author,
            text: oneLine(input.reply.excerpt, 200),
          }),
        ),
      );
    this.add(input.content);
    if (input.attachments?.length)
      this.add(this.t('附件：{names}', { names: input.attachments.map((file) => file.name).join('、') }));
  }
  text() {
    return this.blocks.join('\n\n') + '\n';
  }
}

/** A Bot chat (its main chat or one work session) as Markdown. `messages` are that chat's, oldest first. */
export function exportBotConversation(
  input: { botName: string; messages: ChatMessage[]; runs: readonly RunRecord[] },
  options: ConversationExportOptions,
) {
  const document = new Document(options),
    runs = new Map(input.runs.map((run) => [run.id, run])),
    shown = firstDeliveries(input.messages);
  for (const item of conversationTimeline(input.messages)) {
    if (item.kind === 'message') {
      const message = shown.get(item.message) || item.message;
      if (message.reaction || message.role === 'tool') continue;
      if (message.status === 'running') continue;
      const content =
        message.role === 'assistant'
          ? answerText(message.content)
          : readableQuestionAnswer(previewFeedbackDisplay(message).content);
      if (!content && !message.attachments?.length) continue;
      // Notices (an event, a note about another Bot or a group) are not anyone's words.
      if (message.role === 'event' || message.peer || message.groupLink) {
        document.add(quote(content));
        continue;
      }
      document.speaker(
        message.scheduled
          ? document.t('自动化：{title}', { title: message.scheduled.title })
          : message.taskSource?.name ||
              message.groupTaskSource?.name ||
              (message.role === 'user' ? options.userName : input.botName),
        message.time,
      );
      document.said({ reply: message.reply, content, attachments: message.attachments });
      continue;
    }
    const run = runs.get(item.id),
      view = runPresentation(item.messages, run),
      final = item.isLast ? view.final : undefined,
      answer = final && (shown.get(final) || final),
      steps = runSteps(item.messages, { finalId: final?.id, error: view.error }).filter(
        (step) => step.kind !== 'reasoning',
      );
    const ended =
      !item.isLast || answer
        ? ''
        : view.status === 'failed' || view.status === 'interrupted'
          ? document.t('（任务没有完成）')
          : view.status === 'cancelled'
            ? document.t('（任务已停止）')
            : '';
    if (!steps.length && !answer && !ended) continue;
    document.speaker(input.botName, (answer || item.messages[0]).time);
    if (steps.length)
      document.add(
        options.steps
          ? [
              document.t('处理步骤（{count} 步）', { count: steps.length }),
              ...steps.map((step) => {
                if (step.kind === 'tool') {
                  const display = toolDisplay(step.message);
                  return '- ' + oneLine(display.label + (display.detail ? '：' + display.detail : ''), 200);
                }
                return '- ' + oneLine(answerText(step.message.content), 400);
              }),
            ].join('\n')
          : document.t('（处理步骤 {count} 步）', { count: steps.length }),
      );
    if (answer) document.said({ content: answerText(answer.content), attachments: answer.attachments });
    document.add(ended);
  }
  return document.text();
}

/** A group chat as Markdown: every member's messages, and the notices between them. */
export function exportGroupConversation(
  input: { messages: readonly GroupMessage[]; members: string[]; botName: (id: string) => string | undefined },
  options: ConversationExportOptions,
) {
  const document = new Document(options, (t) =>
    t('成员：{names}', { names: [options.userName, ...input.members].join('、') }),
  );
  for (const message of input.messages) {
    if (message.kind === 'reaction') continue;
    if (message.scheduled) {
      document.speaker(document.t('自动化：{title}', { title: message.scheduled.title }), message.time);
      document.add(message.content);
      continue;
    }
    if (message.kind === 'system' || message.kind === 'continue' || message.sender.kind === 'system') {
      document.add(quote(message.content));
      continue;
    }
    const sender = message.sender,
      content = groupReplyContent(
        previewFeedbackDisplay(message).content,
        sender.kind === 'bot' ? sender.id : undefined,
      );
    if (sender.kind === 'bot' && !message.attachments?.length && isEmptyGroupReply(content)) continue;
    document.speaker(sender.kind === 'bot' ? input.botName(sender.id) || sender.name : options.userName, message.time);
    document.said({ reply: message.reply, content, attachments: message.attachments });
  }
  return document.text();
}

/** A file name for an exported chat: its title and the day, without characters a file system refuses. */
export function conversationExportName(title: string, exportedAt: string) {
  const name =
    title
      .replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[. ]+|[. ]+$/g, '')
      .slice(0, 80)
      .trim() || 'chat';
  return `${name} ${localTime(exportedAt).slice(0, 10)}.md`;
}
