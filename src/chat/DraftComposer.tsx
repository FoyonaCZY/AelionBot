import { memo, type ComponentProps } from 'react';
import { useDraft, type Drafts } from '../app/use-drafts';
import { BotComposer } from './BotComposer';

type DraftComposerProps = Omit<ComponentProps<typeof BotComposer>, 'draft' | 'onChange'> & {
  drafts: Drafts;
  /** The conversation the draft belongs to. */
  draftKey: string;
};

/**
 * A composer bound to a stored draft. Only this component subscribes to the draft, so a keystroke re-renders the
 * composer and not the conversation around it; memo keeps it still while the conversation re-renders.
 */
export const DraftComposer = memo(function DraftComposer({ drafts, draftKey, ...props }: DraftComposerProps) {
  const draft = useDraft(drafts, draftKey);
  return <BotComposer {...props} draft={draft} onChange={(next) => drafts.set(draftKey, next)} />;
});
