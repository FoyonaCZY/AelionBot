import type { ChatMessage } from '../../shared/types/core';
import type { GroupsView } from '../../shared/types/group-types';
import { MessageTime } from '../chat/ConversationTime';
import { Icon } from '../ui/Icon';
import { MentionContent } from '../ui/MentionContent';
import { useI18n } from '../i18n';

export function GroupTaskMessage({
  message,
  view,
  onOpen,
}: {
  message: ChatMessage;
  view?: GroupsView;
  onOpen: (id: string) => void;
}) {
  const { t } = useI18n();
  const source = message.groupTaskSource!,
    room = view?.rooms.find((room) => room.id === source.groupId);
  return (
    <>
      <MessageTime id={message.id} time={message.time} />
      <div className="peer-task-message group-task-message">
        <button className="peer-task-source" disabled={!room} onClick={() => onOpen(source.groupId)}>
          <Icon name="message" size={17} />
          <span>
            {source.continuation ? t('继续来自') : t('来自')} <strong>{room?.name || source.name}</strong>{' '}
            {t('的群任务')}
          </span>
          <Icon name="arrow" size={12} />
        </button>
        <p>
          <MentionContent content={message.content} mentions={message.mentions} />
        </p>
      </div>
    </>
  );
}
