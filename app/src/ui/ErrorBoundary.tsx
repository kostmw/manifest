import { Component, type ErrorInfo, type ReactNode } from 'react';
import { BUTTON_PRIMARY } from './styles';

/** The last resort: without this, an error while rendering leaves a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="mx-auto flex max-w-md flex-col items-start gap-3 p-6">
        <h1 className="text-xl font-semibold">Manifest couldn't start</h1>
        <p className="text-sm leading-relaxed text-zinc-300">
          Something went wrong while showing this page. Your saved batches aren't affected. Reloading usually fixes it.
        </p>
        <button type="button" onClick={() => window.location.reload()} className={BUTTON_PRIMARY}>
          Reload
        </button>
      </div>
    );
  }
}
