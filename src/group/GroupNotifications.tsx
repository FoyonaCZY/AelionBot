import { useEffect, useRef, useState } from 'react';
import type { GroupsView } from '../../shared/types/group-types';
import { GroupAvatar } from './GroupAvatar';
import { Icon } from '../ui/Icon';
import { useI18n } from '../i18n';

export function GroupNotifications({
  view,
  selected,
  onView,
}: {
  view?: GroupsView;
  selected?: string;
  onView: (id: string) => void;
}) {
  const { t } = useI18n();
  const seen = useRef<Map<string, number> | undefined>(undefined),
    [visible, setVisible] = useState<string>();
  useEffect(() => {
    if (!view) return;
    const current = new Map(view.rooms.map((room) => [room.id, room.lastSeq]));
    if (seen.current) {
      const incoming = view.rooms.find(
        (room) => room.id !== selected && room.unread > 0 && room.lastSeq > (seen.current?.get(room.id) || 0),
      );
      if (incoming) setVisible(incoming.id);
    }
    seen.current = current;
  }, [view?.revision]);
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => setVisible(undefined), 6500);
    return () => clearTimeout(timer);
  }, [visible]);
  const room = view?.rooms.find((room) => room.id === visible);
  if (!room || room.id === selected) return null;
  return (
    <aside className="interaction-notification group-notification" role="status">
      <button
        className="interaction-notification-open"
        onClick={() => {
          setVisible(undefined);
          onView(room.id);
        }}
      >
        <GroupAvatar group={room} />
        <span>
          <strong>{room.name}</strong>
          <small>{room.preview}</small>
        </span>
        <span className="notification-view">{t('查看')}</span>
      </button>
      <button
        className="icon-button notification-close"
        aria-label={t('关闭群聊通知')}
        onClick={() => setVisible(undefined)}
      >
        <Icon name="close" size={16} />
      </button>
    </aside>
  );
}
