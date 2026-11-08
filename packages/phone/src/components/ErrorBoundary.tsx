import React from 'react';

// A crash in one screen used to unmount the whole React tree and leave a black
// app (Status → Sessions, Nov 7). This catches render errors and shows a small
// card instead, so the rest of the house keeps working.

interface Props {
  children: React.ReactNode;
  /** Short label for where it broke, e.g. "Sessions". */
  label?: string;
  /** Full-screen fallback (root) vs. inline card (one screen). */
  fullScreen?: boolean;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}]`, error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const where = this.props.label ? `${this.props.label} hit a snag` : 'Something hit a snag';
    return (
      <div
        role="alert"
        style={{
          padding: 16,
          margin: this.props.fullScreen ? 0 : 12,
          minHeight: this.props.fullScreen ? '100dvh' : undefined,
          borderRadius: this.props.fullScreen ? 0 : 16,
          background: 'rgba(20,20,24,0.92)',
          color: '#f3f3f3',
          fontSize: 13,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          justifyContent: this.props.fullScreen ? 'center' : undefined,
        }}
      >
        <strong style={{ fontSize: 14 }}>{where}</strong>
        <span style={{ opacity: 0.75, wordBreak: 'break-word' }}>{error.message || String(error)}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={this.reset} style={btn}>Try again</button>
          {this.props.fullScreen && (
            <button onClick={() => window.location.reload()} style={btn}>Reload</button>
          )}
        </div>
      </div>
    );
  }
}

const btn: React.CSSProperties = {
  padding: '6px 12px',
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.25)',
  background: 'transparent',
  color: 'inherit',
  fontSize: 12,
};
