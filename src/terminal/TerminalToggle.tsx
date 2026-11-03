import type { AttachmentScope } from '../../shared/types/attachment-types';
import { workspaceKey } from '../../shared/types/work-types';
import { useI18n } from '../i18n';
import { Icon } from '../ui/Icon';
import { showTerminal, useTerminalState } from './terminal-sessions';

/** Shows or hides this conversation's floating terminal; the dot says a hidden one is still running. */
export function TerminalToggle({ scope }: { scope: AttachmentScope }) {
  const { t } = useI18n(),
    id = workspaceKey(scope),
    { shown, running } = useTerminalState(id),
    label = shown ? t('隐藏终端') : t('打开终端');
  return (
    <button
      type="button"
      className="icon-button terminal-toggle"
      aria-label={label}
      aria-pressed={shown}
      title={label}
      onClick={() => showTerminal(id, !shown)}
    >
      <Icon name="terminal" size={18} />
      {running && !shown && <span className="terminal-toggle-dot" aria-hidden="true" />}
    </button>
  );
}
