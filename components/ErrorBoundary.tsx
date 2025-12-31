import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
    errorInfo: ErrorInfo | null;
}

class ErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = {
            hasError: false,
            error: null,
            errorInfo: null
        };
    }

    static getDerivedStateFromError(error: Error): Partial<State> {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error('[ErrorBoundary] Caught error:', error);
        console.error('[ErrorBoundary] Component stack:', errorInfo.componentStack);
        this.setState({ errorInfo });
    }

    render() {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback;
            }

            return (
                <div className="fixed inset-0 z-[9999] bg-slate-950 flex flex-col items-center justify-center p-8">
                    <div className="max-w-2xl w-full bg-red-900/20 border border-red-500/50 rounded-2xl p-8">
                        <h1 className="text-2xl font-black text-red-400 mb-4">⚠️ Application Error</h1>
                        <p className="text-red-300 mb-4">Something went wrong while rendering the application.</p>

                        <div className="bg-slate-900 rounded-lg p-4 mb-4 overflow-auto max-h-48">
                            <p className="text-red-400 font-mono text-sm break-all">
                                {this.state.error?.message || 'Unknown error'}
                            </p>
                        </div>

                        {this.state.errorInfo && (
                            <div className="bg-slate-900 rounded-lg p-4 mb-4 overflow-auto max-h-64">
                                <p className="text-xs text-slate-500 uppercase font-bold mb-2">Component Stack:</p>
                                <pre className="text-slate-400 font-mono text-xs whitespace-pre-wrap">
                                    {this.state.errorInfo.componentStack}
                                </pre>
                            </div>
                        )}

                        <button
                            onClick={() => {
                                this.setState({ hasError: false, error: null, errorInfo: null });
                                window.location.reload();
                            }}
                            className="w-full py-3 bg-red-600 hover:bg-red-500 text-white font-bold rounded-xl transition-all"
                        >
                            Reload Application
                        </button>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}

export default ErrorBoundary;
