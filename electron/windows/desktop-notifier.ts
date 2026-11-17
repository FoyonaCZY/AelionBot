// Shows the app's notices as notifications of the operating system.
import { Notification } from 'electron';
import type { DesktopNotice } from '../core/app/desktop-notices';

/** Notifications kept so a click still reaches the app; older ones are let go. */
const KEPT = 20;

export class DesktopNotifier {
  // A notification that is no longer referenced can be collected before it is clicked.
  private readonly live = new Map<string, Notification>();

  constructor(private readonly onClick: (notice: DesktopNotice) => void) {}

  /** Shows the notice, replacing the one with the same tag. False where the system has no notifications. */
  show(notice: DesktopNotice) {
    if (!Notification.isSupported()) return false;
    this.live.get(notice.tag)?.close();
    this.live.delete(notice.tag);
    const item = new Notification({ title: notice.title, body: notice.body });
    const forget = () => {
      if (this.live.get(notice.tag) === item) this.live.delete(notice.tag);
    };
    item.on('click', () => {
      forget();
      this.onClick(notice);
    });
    item.on('close', forget);
    this.live.set(notice.tag, item);
    for (const tag of this.live.keys()) {
      if (this.live.size <= KEPT) break;
      this.live.delete(tag);
    }
    item.show();
    return true;
  }

  dispose() {
    for (const item of this.live.values()) item.close();
    this.live.clear();
  }
}
