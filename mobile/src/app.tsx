// Which screen shows: connecting a computer first, unlocking when the computer asks, then the routed screens.
import { Component, lazy, Suspense, type ReactNode } from 'react';
import { translate } from '../../shared/i18n';
import { useConnection } from './connection';
import { back, useRoute } from './router';
import { I } from './icons';
import { Spinner, Toasts } from './ui';
import { Chat } from './screens/Chat';
import { FilesScreen } from './screens/Files';
import { Group } from './screens/Group';
import { Home } from './screens/Home';
import { Settings } from './screens/Settings';
import { Lock, Welcome } from './screens/Welcome';

// The remote desktop viewer is large and rarely opened: loaded when needed.
const Computer = lazy(() => import('./screens/Computer').then((module) => ({ default: module.Computer })));

/** A screen that failed shows what happened and the way home, instead of leaving the app blank. */
class Boundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="x-failed">
        <b>{translate('这个页面出错了')}</b>
        <small>{this.state.error.message}</small>
        <button
          className="x-btn"
          onClick={() => {
            // A reload also brings the newest app, if a file of an older one was missing.
            location.replace(location.pathname + '#/');
            location.reload();
          }}
        >
          {translate('回到首页')}
        </button>
      </div>
    );
  }
}

function ComputerLoading() {
  return (
    <div className="pc-screen">
      <header className="c-nav is-dark">
        <button className="x-round" aria-label={translate('关闭')} onClick={back}>
          <I name="close" size={24} stroke={2} />
        </button>
      </header>
      <div className="pc-overlay">
        <Spinner />
      </div>
    </div>
  );
}

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
    case 'new':
      return <Chat key={route.botId + ':new'} botId={route.botId} fresh />;
    case 'group':
      return <Group key={route.id} id={route.id} />;
    case 'computer':
      return (
        <Suspense fallback={<ComputerLoading />}>
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
  const route = useRoute();
  return (
    <>
      {/* Keyed by the route: leaving a failed screen gives the next one a fresh start. */}
      <Boundary key={JSON.stringify(route)}>
        <Screen />
      </Boundary>
      <Toasts />
    </>
  );
}
