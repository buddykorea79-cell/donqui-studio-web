import React from "react";
import ReactDOM from "react-dom/client";
import { WebStudio } from "./WebStudio";
import "../styles/fonts.css";
import "./web.css";

class ErrorBoundary extends React.Component<React.PropsWithChildren, { error: string | null }> {
	state = { error: null as string | null };
	static getDerivedStateFromError(error: Error) {
		return { error: error.message };
	}
	render() {
		if (this.state.error)
			return (
				<main className="boot-screen">
					<h1>편집기를 열 수 없습니다</h1>
					<p>{this.state.error}</p>
					<button type="button" onClick={() => location.reload()}>
						다시 열기
					</button>
				</main>
			);
		return this.props.children;
	}
}

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<ErrorBoundary>
			<WebStudio />
		</ErrorBoundary>
	</React.StrictMode>,
);
