import { Component, type ErrorInfo, type ReactNode } from "react";

type State = { error: Error | null };

export default class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[iris] renderer crashed", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="fatal-boundary" role="alert">
        <h1>Iris encountered a renderer error</h1>
        <p>{this.state.error.message}</p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload Iris
        </button>
      </main>
    );
  }
}
