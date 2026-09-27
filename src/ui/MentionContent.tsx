import React, { useMemo } from 'react';
import { defaultUrlTransform } from 'react-markdown';
import type { BotMention } from '../../shared/types/core';
import { mentionMarkdown, validMentions } from '../../shared/chat/mentions';
import Markdown from '../chat/MessageMarkdown';
import { MessageLink } from '../chat/MessageLink';
import { Avatar } from './Avatar';

function MentionTag({ mention }: { mention: BotMention }) {
  return (
    <span className="bot-mention" data-bot-id={mention.id} title={`${mention.name} · ${mention.id.slice(0, 8)}`}>
      <Avatar bot={mention} size={16} />@{mention.name}
    </span>
  );
}
export function MentionContent({
  content,
  mentions = [],
  markdown = false,
}: {
  content: string;
  mentions?: BotMention[];
  markdown?: boolean;
}) {
  const prepared = useMemo(
    () => (markdown && mentions.length ? mentionMarkdown(content, mentions) : undefined),
    [content, JSON.stringify(mentions), markdown],
  );
  if (markdown)
    return (
      <Markdown
        urlTransform={(url) => (prepared?.links.has(url) ? url : defaultUrlTransform(url))}
        components={{
          a: ({ href, children, node: _node, ...props }) => {
            const mention = href ? prepared?.links.get(href) : undefined;
            return mention ? (
              <MentionTag mention={mention} />
            ) : (
              <MessageLink href={href} {...props}>
                {children}
              </MessageLink>
            );
          },
        }}
      >
        {prepared?.markdown || content}
      </Markdown>
    );
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const mention of validMentions(content, mentions)) {
    parts.push(
      content.slice(at, mention.start),
      <MentionTag key={`${mention.id}-${mention.start}`} mention={mention} />,
    );
    at = mention.end;
  }
  parts.push(content.slice(at));
  return <>{parts}</>;
}
