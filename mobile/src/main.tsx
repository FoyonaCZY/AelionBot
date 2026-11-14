// The phone app's entry: language, the computer to show, the service worker, then React.
import { createRoot } from 'react-dom/client';
import { startI18n } from './i18n';
import { connection } from './connection';
import { App } from './app';
import { takeLinkFromAddress } from './screens/Welcome';
import { go } from './router';
import './mobile.css';

startI18n();
takeLinkFromAddress();

/** A notification names the computer it came from (?c=room) and the screen to open. */
async function openFromNotification(url: string) {
  const target = new URL(url, location.href);
  const room = target.searchParams.get('c');
  if (room && room !== connection.state.computer?.room && connection.state.computers.some((item) => item.room === room))
    await connection.select(room);
  if (target.hash) go(target.hash, true);
}

void connection.init().then(() => {
  if (new URLSearchParams(location.search).has('c')) {
    void openFromNotification(location.href);
    history.replaceState(null, '', location.pathname + location.hash);
  }
});

if ('serviceWorker' in navigator && !import.meta.env.DEV) {
  void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'open' && typeof event.data.url === 'string') void openFromNotification(event.data.url);
  });
}

createRoot(document.getElementById('root')!).render(<App />);
