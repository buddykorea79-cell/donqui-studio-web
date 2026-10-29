// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AxcutDocument, createAudioTrack, createEmptyDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import type { VClipWindowAnalysis, VClipWindowRequest } from "@/lib/vclip/contract";
import { useVClipStore } from "@/lib/vclip/store";
import { useVisionModelStore } from "@/lib/vclip/visionModels";
import { VClipStage } from "./VClipStage";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: {} } }));

const drone = {
	id: "drone",
	kind: "video" as const,
	label: "DJI_0017.MP4",
	originalPath: "C:/footage/DJI_0017.MP4",
	cameraTrack: null,
};
const beach = {
	id: "beach",
	kind: "video" as const,
	label: "BEACH.MP4",
	originalPath: "C:/footage/BEACH.MP4",
	cameraTrack: null,
};
const api = {
	vclipListModels: vi.fn(),
	vclipProbe: vi.fn(),
	vclipAnalyzeWindow: vi.fn(),
	vclipCancel: vi.fn(),
	vclipThumbnail: vi.fn(),
	openVideoFilesPicker: vi.fn(),
};
const save = vi.fn(async (document: AxcutDocument, _options: { history: boolean }) => {
	useProjectStore.setState({ document });
	return true;
});
const onContinue = vi.fn();
const onOpenAiSettings = vi.fn();
const initialVClip = useVClipStore.getState();
const initialVision = useVisionModelStore.getState();
const initialProject = useProjectStore.getState();

function judged(request: VClipWindowRequest): VClipWindowAnalysis {
	const score = 90 - request.startSec - (request.sourcePath.includes("BEACH") ? 1 : 0);
	return {
		startSec: request.startSec,
		endSec: request.endSec,
		score,
		qualityScore: 77,
		reason: `바다 위 구간 ${request.startSec}`,
		quality: { brightness: 0.8, motion: 0.6, sharpness: 0.7, stability: 0.9 },
		ai: {
			score,
			category: "orbit",
			description: `바다 위 구간 ${request.startSec}`,
			caption: "절벽을 돌아",
			tags: ["sea"],
		},
		aiError: null,
		thumbnail: null,
	};
}

function project(audioSec: number): AxcutDocument {
	const document = createEmptyDocument({ projectId: "p", title: "V.Clip" });
	document.assets = [
		drone,
		beach,
		{
			id: "song",
			kind: "audio",
			label: "song.mp3",
			originalPath: "C:/music/song.mp3",
			cameraTrack: null,
		},
		{
			id: "rendered",
			kind: "video",
			label: "rendered clip",
			originalPath: "C:/Users/me/AppData/Roaming/Donqui/media/clip-effects/abc.mp4",
			cameraTrack: null,
		},
	];
	if (audioSec > 0)
		document.audioTracks = [
			createAudioTrack({ assetId: "song", durationSec: audioSec, kind: "music", label: "BGM" }),
		];
	return document;
}

function renderStage() {
	return render(<VClipStage onContinue={onContinue} onOpenAiSettings={onOpenAiSettings} />);
}

function panel(name: string) {
	return screen.getByRole("region", { name: `${name} 구간` });
}

async function analyseAll() {
	const button = await screen.findByRole("button", { name: /모든 영상 구간 찾기/ });
	fireEvent.click(button);
	await waitFor(() => expect(within(panel("BEACH.MP4")).getAllByRole("article")).toHaveLength(4));
	await waitFor(() =>
		expect(
			within(panel("BEACH.MP4")).getByRole("button", { name: /구간 다시 찾기/ }),
		).toBeEnabled(),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	useVClipStore.setState(initialVClip, true);
	useVClipStore.setState({ segmentSec: 5 });
	useVisionModelStore.setState(
		{ ...initialVision, chosen: undefined, models: null, loading: false },
		true,
	);
	useProjectStore.setState({ projectId: "p", document: project(12), saveDocument: save });
	Object.defineProperty(window, "electronAPI", { configurable: true, value: api });
	api.vclipListModels.mockResolvedValue({
		available: true,
		baseUrl: "http://127.0.0.1:11434",
		error: null,
		models: [{ name: "qwen3-vl:4b", size: 3, parameterSize: "4.4B" }],
	});
	api.vclipProbe.mockResolvedValue({
		success: true,
		durationSec: 20,
		width: 3840,
		height: 2160,
		fps: 29.97,
		hasAudio: false,
	});
	api.vclipAnalyzeWindow.mockImplementation(async (request: VClipWindowRequest) => ({
		success: true,
		result: judged(request),
	}));
	api.vclipThumbnail.mockResolvedValue({ success: true, dataUrl: "data:image/jpeg;base64,AA==" });
});
afterEach(() => {
	cleanup();
	useProjectStore.setState(initialProject);
});

describe("VClipStage", () => {
	it("lays every source video out on one page, with what FFmpeg read from it", async () => {
		renderStage();
		expect(panel("DJI_0017.MP4")).toBeInTheDocument();
		expect(panel("BEACH.MP4")).toBeInTheDocument();
		// Audio and the clips this app rendered are not footage to split.
		expect(screen.queryByRole("region", { name: "song.mp3 구간" })).toBeNull();
		expect(screen.queryByRole("region", { name: "rendered clip 구간" })).toBeNull();
		expect(
			await within(panel("DJI_0017.MP4")).findByText("0:20.0 · 3840×2160 · 29.97 fps · 소리 없음"),
		).toBeInTheDocument();
		expect(await screen.findByText("분석 모델 qwen3-vl:4b")).toBeInTheDocument();
		expect(screen.getByText(/남은 0:12\.0/)).toBeInTheDocument();
		expect(screen.getByLabelText("클립 길이 (초)")).toHaveValue(5);
	});

	it("opens the AI settings for the model, where the Ollama options live", async () => {
		renderStage();
		fireEvent.click(await screen.findByRole("button", { name: /AI 설정/ }));
		expect(onOpenAiSettings).toHaveBeenCalled();
		expect(screen.queryByLabelText("분석 모델")).toBeNull();
	});

	it("analyses every video, preselects each one's best three and splits them into the bin", async () => {
		renderStage();
		await analyseAll();
		const drones = within(panel("DJI_0017.MP4")).getAllByRole("article");
		expect(drones).toHaveLength(4);
		expect(within(drones[0]).getByText("선회")).toBeInTheDocument();
		expect(within(drones[0]).getByText("“절벽을 돌아”")).toBeInTheDocument();
		expect(api.vclipAnalyzeWindow.mock.calls[0][0]).toMatchObject({ model: "qwen3-vl:4b" });

		const split = screen.getAllByRole("button", { name: /선택한 구간 6개 클립으로 나누기/ })[0];
		fireEvent.click(split);
		await waitFor(() =>
			expect(useProjectStore.getState().document?.mediaBoard?.clips).toHaveLength(6),
		);
		expect(save).toHaveBeenCalledWith(expect.anything(), { history: true });
		expect(await screen.findAllByText("클립 나눔")).toHaveLength(6);
		expect(screen.getAllByRole("button", { name: /선택한 구간 0개/ })[0]).toBeDisabled();
		// Nothing was rendered: splitting only records ranges.
		expect(screen.queryByLabelText("Remotion 효과")).toBeNull();
	});

	it("adjusts a segment's range with the nudges and the length field", async () => {
		renderStage();
		await analyseAll();
		const card = within(panel("DJI_0017.MP4")).getAllByRole("article")[1];
		expect(within(card).getByText("0:05.0–0:10.0 · 5.0초")).toBeInTheDocument();
		fireEvent.click(within(card).getByRole("button", { name: "시작 +0.5초" }));
		expect(await within(card).findByText("0:05.5–0:10.0 · 4.5초")).toBeInTheDocument();
		const length = within(card).getByLabelText("길이 (초)");
		fireEvent.change(length, { target: { value: "7" } });
		fireEvent.blur(length);
		expect(await within(card).findByText("0:05.5–0:12.5 · 7.0초")).toBeInTheDocument();
	});

	it("previews a segment from its source and sets its edges from playback", async () => {
		renderStage();
		await analyseAll();
		const card = within(panel("DJI_0017.MP4")).getAllByRole("article")[2];
		fireEvent.click(within(card).getByRole("button", { name: "0:10.0–0:15.0 구간 미리보기" }));
		const video = within(card).getByLabelText("구간 미리보기") as HTMLVideoElement;
		expect(video.getAttribute("src")).toBe("file:///C:/footage/DJI_0017.MP4");
		Object.defineProperty(video, "currentTime", {
			configurable: true,
			writable: true,
			value: 12.3,
		});
		await waitFor(() => expect(within(card).getByText(/0:12\.3/)).toBeInTheDocument());
		fireEvent.click(within(card).getByRole("button", { name: "여기를 끝으로" }));
		expect(
			useVClipStore.getState().runs["p:drone"].segments.find((segment) => segment.startSec === 10)
				?.endSec,
		).toBeCloseTo(12.3);
		fireEvent.click(within(card).getByRole("button", { name: "미리보기 닫기" }));
		expect(within(card).queryByLabelText("구간 미리보기")).toBeNull();
	});

	it("adds a segment by hand at the chosen clip length, and gives every segment one length", async () => {
		renderStage();
		const drones = panel("DJI_0017.MP4");
		const add = within(drones).getByRole("button", { name: /구간 직접 추가/ });
		await waitFor(() => expect(add).toBeEnabled());
		fireEvent.click(add);
		expect(await within(drones).findByText("0:00.0–0:05.0 · 5.0초")).toBeInTheDocument();
		expect(within(drones).getByText("직접 추가")).toBeInTheDocument();

		fireEvent.change(screen.getByLabelText("클립 길이 (초)"), { target: { value: "3" } });
		fireEvent.click(screen.getByRole("button", { name: "모든 구간에 적용" }));
		expect(await within(drones).findByText("0:00.0–0:03.0 · 3.0초")).toBeInTheDocument();
	});

	it("refuses a clip length outside 2–20 seconds", async () => {
		renderStage();
		fireEvent.change(screen.getByLabelText("클립 길이 (초)"), { target: { value: "30" } });
		expect(screen.getByText(/클립 길이는 2~20초 사이로 입력하세요/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /모든 영상 구간 찾기/ })).toBeDisabled();
	});

	it("selects just enough across the videos to cover the audio still without a clip", async () => {
		renderStage();
		await analyseAll();
		fireEvent.click(screen.getAllByRole("button", { name: /선택 해제/ })[0]);
		expect(screen.getAllByRole("button", { name: /선택한 구간 0개/ })[0]).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "남은 Audio만큼 선택" }));
		// 12 s of music: the best 5 s windows of each video, and one more.
		expect(screen.getAllByRole("button", { name: /선택한 구간 3개/ })[0]).toBeEnabled();
	});

	it("keeps found windows locked until the analysis has ranked them", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		api.vclipAnalyzeWindow.mockImplementation(async (request: VClipWindowRequest) => {
			if (request.startSec > 0) await gate;
			return { success: true, result: judged(request) };
		});
		renderStage();
		try {
			fireEvent.click(await screen.findByRole("button", { name: /모든 영상 구간 찾기/ }));
			const drones = panel("DJI_0017.MP4");
			const card = await within(drones).findByRole("article");
			expect(within(card).getByRole("button", { name: "넣기" })).toBeDisabled();
			expect(within(card).getByRole("button", { name: "시작 +0.5초" })).toBeDisabled();
			const toolbar = screen.getByRole("region", { name: "V.Clip 설정" });
			expect(within(toolbar).getByRole("button", { name: /분석 멈추기/ })).toBeInTheDocument();
			expect(
				within(panel("BEACH.MP4")).getByRole("button", { name: /대기 취소/ }),
			).toBeInTheDocument();
			release();
			await waitFor(() => expect(within(drones).getAllByRole("article")).toHaveLength(4));
			const first = within(drones).getAllByRole("article")[0];
			await waitFor(() =>
				expect(within(first).getByRole("button", { name: "빼기" })).toBeEnabled(),
			);
		} finally {
			// A held analysis would keep the queue busy for the tests after this one.
			release();
			await waitFor(() => expect(useVClipStore.getState().queue).toEqual([]));
			await waitFor(() =>
				expect(
					Object.values(useVClipStore.getState().runs).some((run) => run.status === "analyzing"),
				).toBe(false),
			);
		}
	});

	it("says so when Ollama is not running, and still analyses by frame quality", async () => {
		api.vclipListModels.mockResolvedValue({
			available: false,
			baseUrl: "http://127.0.0.1:11434",
			error: "fetch failed",
			models: [],
		});
		renderStage();
		expect(await screen.findByText(/Ollama 연결 안 됨/)).toBeInTheDocument();
		await analyseAll();
		expect(api.vclipAnalyzeWindow.mock.calls[0][0]).toMatchObject({ model: null });
	});

	it("imports several videos in one pick", async () => {
		const addAsset = vi.fn(async (path: string, label?: string) => {
			const state = useProjectStore.getState();
			const asset = {
				id: `asset-${label}`,
				kind: "video" as const,
				label: label ?? path,
				originalPath: path,
				cameraTrack: null,
			};
			useProjectStore.setState({
				document: state.document
					? { ...state.document, assets: [...state.document.assets, asset] }
					: null,
			});
			return asset;
		});
		useProjectStore.setState({ addAsset });
		api.openVideoFilesPicker.mockResolvedValue({
			success: true,
			files: [
				{ path: "C:/footage/A.MP4", name: "A.MP4" },
				{ path: "C:/footage/DJI_0017.MP4", name: "DJI_0017.MP4" },
				{ path: "C:/footage/B.MP4", name: "B.MP4" },
			],
			rejected: [],
		});
		renderStage();
		fireEvent.click(screen.getByRole("button", { name: /영상 가져오기/ }));
		await waitFor(() => expect(addAsset).toHaveBeenCalledTimes(2));
		expect(await screen.findByRole("region", { name: "A.MP4 구간" })).toBeInTheDocument();
		expect(screen.getByRole("region", { name: "B.MP4 구간" })).toBeInTheDocument();
	});

	it("asks for footage when the project has none", () => {
		const document = createEmptyDocument({ projectId: "p", title: "Empty" });
		useProjectStore.setState({ document });
		renderStage();
		expect(screen.getByText("나눌 영상을 가져오세요")).toBeInTheDocument();
	});
});
