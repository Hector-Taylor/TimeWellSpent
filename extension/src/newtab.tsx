import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { NewTabApp } from './newtab/NewTabApp';
import './newtab.css';

type RootBoundaryProps = {
  children: ReactNode;
};

type RootBoundaryState = {
  hasError: boolean;
};

class NewTabRootBoundary extends Component<RootBoundaryProps, RootBoundaryState> {
  state: RootBoundaryState = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('New tab homepage crashed', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="newtab-root">
          <section className="newtab-shell">
            <article className="newtab-card">
              <h2>TimeWellSpent home hit a rendering error</h2>
              <p className="hint">Refresh this tab. If it keeps happening, restart the desktop app and reload the extension.</p>
            </article>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <NewTabRootBoundary>
      <NewTabApp />
    </NewTabRootBoundary>
  </StrictMode>,
);
