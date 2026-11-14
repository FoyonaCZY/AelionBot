// Which screen shows: connecting a computer first, unlocking when the computer asks, then the routed screens.
import { lazy, Suspense } from 'react';
import { useConnection } from './connection';
import { useRoute } from './router';
import { Toasts } from './ui';
import { Chat } from './screens/Chat';
import { FilesScreen } from './screens/Files';
import { Group } from './screens/Group';
import { Home } from './screens/Home';
import { Settings } from './screens/Settings';
import { Lock, Welcome } from './screens/Welcome';

// The remote desktop viewer is large and rarely opened: loaded when needed.
const Computer = lazy(() => import('./screens/Computer').then((module) => ({ default: module.Computer })));

function Screen() {
  const state = useConnection();
  const route = useRoute();
  if (!state.loaded) return null;
  if (!state.computer || route.name === 'pair' || state.computer.pairing || state.status === 'rejected')
    return <Welcome />;
  if (state.status === 'locked') return <Lock />;
  switch (route.name) {
    case 'chat':
      return <Chat key={route.botId + ':' + (route.sessionId || '')} botId={route.botId} sessionId={route.sessionId} />;
    case 'group':
      return <Group key={route.id} id={route.id} />;
    case 'computer':
      return (
        <Suspense fallback={null}>
          <Computer key={route.botId} botId={route.botId} />
        </Suspense>
      );
    case 'files':
      return <FilesScreen key={route.botId} botId={route.botId} />;
    case 'settings':
      return <Settings />;
    default:
      return <Home />;
  }
}

export function App() {
  return (
    <>
      <Screen />
      <Toasts />
    </>
  );
}
