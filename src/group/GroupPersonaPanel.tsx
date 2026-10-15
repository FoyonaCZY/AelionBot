import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { TRAITS, type Traits } from '../../shared/persona/persona-model';
import type { PersonaView } from '../../shared/types/persona-types';
import { Avatar } from '../ui/Avatar';
import { Icon } from '../ui/Icon';
import { useI18n } from '../i18n';
import { PersonaPage } from './PersonaPage';
import { TRAIT_POLES, relationWord, traitName } from './persona-view-model';

type Member = {
  id: string;
  name: string;
  color?: string;
  avatarStyle?: import('../../shared/chat/bot-colors').BotAvatarStyle;
};

/** Persona views of group members, read when needed and refreshed while something shows them. */
function usePersonaViews(ids: string[], active: boolean) {
  const [views, setViews] = useState<Record<string, PersonaView>>({});
  const key = ids.join('\n');
  const load = useCallback(async () => {
    const entries = await Promise.all(
      (key ? key.split('\n') : []).map(async (botId) => {
        try {
          return [botId, await window.aelion.personaProfile({ botId })] as const;
        } catch {
          return undefined;
        }
      }),
    );
    setViews(Object.fromEntries(entries.filter((e): e is readonly [string, PersonaView] => !!e)));
  }, [key]);
  useEffect(() => {
    if (!active) return;
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [active, load]);
  return views;
}

/** The one or two traits furthest from average, in everyday words, e.g. 「外向 · 敏感」. */
function personaLabel(traits: Traits) {
  return TRAITS.map((k) => ({ k, d: traits[k] - 0.5 }))
    .filter((x) => Math.abs(x.d) >= 0.15)
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
    .slice(0, 2)
    .map((x) => TRAIT_POLES[x.k][x.d > 0 ? 1 : 0]);
}

function TraitBars({ traits }: { traits: Traits }) {
  const { t } = useI18n();
  return (
    <span className="gp-bars" aria-hidden="true">
      {TRAITS.map((k) => (
        <span key={k} title={`${t(traitName(k))} ${Math.round(traits[k] * 100)}`}>
          <i style={{ height: `${Math.max(8, traits[k] * 100)}%` }} />
        </span>
      ))}
    </span>
  );
}

function memberName(members: Member[], id: string, you: string) {
  return id === 'user' ? you : members.find((m) => m.id === id)?.name;
}

/** Each member's personality, how it feels about you and about other members, with a way into its full profile. */
export function GroupPersonaPanel({ members, onClose }: { members: Member[]; onClose: () => void }) {
  const { t } = useI18n();
  const views = usePersonaViews(
    members.map((m) => m.id),
    true,
  );
  const [profile, setProfile] = useState('');
  return (
    <aside className="gp-panel" aria-label={t('成员与性格')}>
      <header>
        <b>{t('成员与性格')}</b>
        <span className="gp-spacer" />
        <button className="icon-button" aria-label={t('关闭')} onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </header>
      <ul>
        {members.map((m) => {
          const view = views[m.id];
          const toYou = view?.relations.find((r) => r.id === 'user')?.affinity ?? 0;
          const others = (view?.relations || [])
            .filter((r) => r.id !== 'user' && memberName(members, r.id, t('你')))
            .slice(0, 2);
          return (
            <li key={m.id} className="gp-member">
              <Avatar bot={{ ...m, color: m.color || '#8e7ca2' }} size={34} />
              <div>
                <div className="gp-name">
                  <b>{m.name}</b>
                  {view && (
                    <small>
                      {personaLabel(view.profile.traits)
                        .map((w) => t(w))
                        .join(' · ') || t('性格均衡')}
                    </small>
                  )}
                  {view && !view.profile.confirmed && <span className="gp-tag">{t('未确认')}</span>}
                </div>
                {view ? (
                  <>
                    <TraitBars traits={view.profile.traits} />
                    <p className="gp-relations">{t('对你：{word}', { word: t(relationWord(toYou)) })}</p>
                    {others.map((r) => (
                      <p className="gp-relations" key={r.id}>
                        {t('对 {name}：{word}', {
                          name: memberName(members, r.id, t('你'))!,
                          word: t(relationWord(r.affinity)),
                        })}
                      </p>
                    ))}
                  </>
                ) : (
                  <p className="gp-relations">{t('正在读取性格…')}</p>
                )}
              </div>
              <button className="secondary-button" onClick={() => setProfile(m.id)}>
                {t('人格档案')}
              </button>
            </li>
          );
        })}
      </ul>
      {profile && <PersonaDialog members={members} botId={profile} onClose={() => setProfile('')} />}
    </aside>
  );
}

/** The full personality page, opened from a group instead of the AI games window. */
function PersonaDialog({ members, botId, onClose }: { members: Member[]; botId: string; onClose: () => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const close = () => {
    if (dirty && !window.confirm(t('有未保存的修改，确定放弃并离开吗？'))) return;
    onClose();
  };
  return (
    <dialog
      ref={dialog}
      className="gp-dialog"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header>
        <b>{t('人格')}</b>
        <span className="gp-spacer" />
        <button className="icon-button" aria-label={t('关闭')} onClick={close}>
          <Icon name="close" size={16} />
        </button>
      </header>
      <PersonaPage members={members} presets={{}} initialBotId={botId} onUnsavedChange={setDirty} />
    </dialog>
  );
}

/** A small card on hover over a member's avatar: its personality in two words, how it feels about you, one memory. */
export function PersonaHoverCard({ bot, children }: { bot: Member; children: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const views = usePersonaViews([bot.id], open);
  const view = views[bot.id];
  const toYou = view?.relations.find((r) => r.id === 'user')?.affinity ?? 0;
  const memory = view?.highlights.find((h) => h.participants?.includes('user'));
  return (
    <span
      className="gp-hover"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && view && (
        <span className="gp-hover-card" role="tooltip">
          <b>{bot.name}</b>
          <small>
            {personaLabel(view.profile.traits)
              .map((w) => t(w))
              .join(' · ') || t('性格均衡')}
          </small>
          <TraitBars traits={view.profile.traits} />
          <span>{t('对你：{word}', { word: t(relationWord(toYou)) })}</span>
          {memory && <span className="gp-memory">{memory.summary}</span>}
        </span>
      )}
    </span>
  );
}
