/**
 * The last line of defence.
 *
 * A render error in a single-window desktop app is not a broken page the user
 * can navigate away from — it is a blank window with no menu, no context and
 * nothing to click. This catches it, keeps the window usable, and gives the one
 * action that reliably helps.
 *
 * The message is shown rather than hidden. Main redacts what it sends across
 * IPC, but this is our own stack in our own process, and a user who can read
 * "Cannot read properties of undefined (reading 'branch')" can write a bug
 * report worth acting on.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] unhandled render error', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        className="flex h-full w-full items-center justify-center bg-background px-6 text-foreground"
      >
        <div className="max-w-md">
          <h1 className="font-serif text-title">Juno hit an error it could not recover from</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            The window is still open, but this view stopped rendering. Reloading restarts the interface
            without touching your data.
          </p>
          <pre className="mt-4 max-h-40 overflow-auto whitespace-pre-wrap rounded-card border border-border bg-card p-3 font-mono text-caption leading-relaxed text-muted-foreground">
            {error.message}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 inline-flex h-8 items-center rounded-control bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Reload the interface
          </button>
        </div>
      </div>
    );
  }
}
