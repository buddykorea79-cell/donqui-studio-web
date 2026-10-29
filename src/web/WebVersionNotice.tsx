import { ExternalLink, X } from "lucide-react";
import { useEffect, useRef } from "react";

export const WEB_NOTICE_SEEN_KEY = "donqui-web-notice-seen-v1";

export function hasSeenWebNotice() {
	try {
		return localStorage.getItem(WEB_NOTICE_SEEN_KEY) === "true";
	} catch {
		return false;
	}
}

export function rememberWebNotice() {
	try {
		localStorage.setItem(WEB_NOTICE_SEEN_KEY, "true");
	} catch {
		// The notice must still close when browser storage is unavailable.
	}
}

export function WebVersionNotice({ open, onDismiss }: { open: boolean; onDismiss: () => void }) {
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		else if (!open && dialog.open) dialog.close();
	}, [open]);

	return (
		<dialog
			ref={ref}
			className="modal web-version-notice"
			aria-labelledby="web-notice-title"
			aria-describedby="web-notice-intro"
			onCancel={(event) => {
				event.preventDefault();
				onDismiss();
			}}
		>
			<button
				type="button"
				className="modal-close icon-button"
				aria-label="안내 닫기"
				onClick={onDismiss}
			>
				<X size={18} />
			</button>
			<span className="eyebrow">DONQUI STUDIO</span>
			<h2 id="web-notice-title">웹 버전 안내</h2>
			<p id="web-notice-intro">
				Donqui Studio는 원래 내 컴퓨터에서 실행하는 프로그램입니다. 웹에서는 기본 편집과 영상
				내보내기를 사용할 수 있습니다.
			</p>
			<ul>
				<li>AI 장면 분석·음성 인식 자동 자막 미지원</li>
				<li>마이크·웹캠 녹화 및 합성·커서 추적 미지원</li>
				<li>일부 코덱·긴 고해상도 영상은 브라우저 성능에 따라 제한</li>
				<li>작업은 이 브라우저에만 저장되며, 기존 로컬 프로젝트와 호환되지 않음</li>
			</ul>
			<p>로컬 버전은 GitHub에서 내려받을 수 있습니다.</p>
			<div className="web-notice-actions">
				<a
					className="secondary"
					href="https://github.com/buddykorea79-cell/Donqui-Studio.git"
					target="_blank"
					rel="noopener noreferrer"
				>
					로컬 버전 받기 <ExternalLink size={14} aria-hidden="true" />
				</a>
				<button type="button" className="primary" onClick={onDismiss}>
					웹에서 계속하기
				</button>
			</div>
		</dialog>
	);
}
