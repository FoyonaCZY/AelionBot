import type { GroupSummary } from '../../shared/types/group-types';
import type { BotActivities } from '../bots/bot-activity';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { useI18n } from '../i18n';

export function GroupAvatar({ group, activities = {} }: { group: GroupSummary; activities?: BotActivities }) {
  const { t } = useI18n();
  const members = group.members.filter((member) => !member.leftAt).slice(0, 4);
  return (
    <span className="group-avatar" data-count={members.length} role="img" aria-label={t('群聊')}>
      {members.length ? (
        members.map((member) => <Avatar key={member.id} bot={member} activity={activities[member.id]} />)
      ) : (
        <Icon name="message" size={23} />
      )}
    </span>
  );
}
