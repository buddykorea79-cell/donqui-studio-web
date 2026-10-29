// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import { LOCALE_STORAGE_KEY } from "@/i18n/config";
import {
	type AxcutAsset,
	type AxcutDocument,
	createAudioTrack,
	createEmptyDocument,
} from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	addLayers,
	applyMix,
	audioBoardOf,
	mixSignature,
	mixSpec,
	updateLayer,
} from "@/lib/audio-board/board";
import {
	addBoardImages,
	addBoardItems,
	boardOf,
	clipItem,
	itemDurationSec,
	upsertBoardClips,
} from "@/lib/media-board/board";
import { useMediaPreview } from "@/lib/media-board/preview";
import { useComposeStore } from "@/lib/media-board/store";
import { MediaStage } from "./MediaStage";

const mocks = vi.hoisted(() => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/native/client", () => ({ nativeBridgeClient: { aiEdition: {} } }));
vi.mock("@/hooks/useAudioPeaks", () => ({ useAudioPeaks: () => null }));
// The Remotion player needs a real browser; what matters here is what it is asked to play.
vi.mock("./MediaPreview", () => ({
	MediaPreview: (props: {
		parts: Array<{ sourceKind: string; effect: string; startMs: number; frames: number }>;
		audio: Array<{ url: string }>;
		width: number;
		height: number;
	}) => (
		<div data-testid="media-preview">
			{props.width}x{props.height}|
			{props.parts
				.map((part) => `${part.sourceKind}:${part.effect}:${part.startMs}:${part.frames}`)
				.join(",")}
			|audio:{props.audio.length}
		</div>
	),
}));
vi.mock("@/lib/media-board/apply", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/media-board/apply")>()),
	readImageSize: vi.fn(async () => ({ width: 4000, height: 3000 })),
}));

const drone: AxcutAsset = {
	id: "drone",
	kind: "video",
	label: "DJI_0017.MP4",
	originalPath: "C:/footage/DJI_0017.MP4",
	durationSec: 60,
	video: { codec: "hevc", fps: 29.97, width: 3840, height: 2160 },
	cameraTrack: null,
};
const api = {
	openImageFilesPicker: vi.fn(),
	openVideoFilesPicker: vi.fn(),
	vclipThumbnail: vi.fn(),
	vclipProbe: vi.fn(),
};
const save = vi.fn(async (document: AxcutDocument, _options: { history: boolean }) => {
	useProjectStore.setState({ document });
	return true;
});
const apply = vi.fn(async () => undefined);
const onAddToTimeline = vi.fn(async () => undefined);
const onOpenInVClip = vi.fn();
const initialProject = useProjectStore.getState();
const initialCompose = useComposeStore.getState();

/** Two clips split in V.Clip and 12 s of music. */
function project(): AxcutDocument {
	const document = {
		...createEmptyDocument({ projectId: "p", title: "Media" }),
		assets: [drone],
		audioTracks: [
			{
				...createAudioTrack({ assetId: "music", durationSec: 12, kind: "music" as const }),
				timelineLocked: true,
			},
		],
	};
	return upsertBoardClips(document, [
		{
			assetId: "drone",
			startSec: 10,
			endSec: 15,
			label: "DJI · 0:10.0–0:15.0",
			note: "절벽을 돌아",
		},
		{ assetId: "drone", startSec: 0, endSec: 4, label: "DJI · 0:00.0–0:04.0", score: 88 },
	]).document;
}

function board() {
	return boardOf(useProjectStore.getState().document);
}

function renderMedia() {
	return render(
		<I18nProvider>
			<MediaStage onAddToTimeline={onAddToTimeline} onOpenInVClip={onOpenInVClip} />
		</I18nProvider>,
	);
}

const composition = () => screen.getByRole("region", { name: "조합" });
const timeline = () => screen.getByRole("region", { name: "Media 타임라인" });
const blocks = () => within(timeline()).getAllByRole("button", { name: /^\d+번 / });

/** A click on a timeline block: pressed and let go without moving. */
function clickBlock(name: RegExp) {
	const block = within(timeline()).getByRole("button", { name });
	fireEvent.pointerDown(block, { clientX: 10, button: 0 });
	fireEvent.pointerUp(block, { clientX: 10 });
	return block;
}

/** Every element 1000 px wide from 0, so a pixel is `view / 1000` seconds. */
function measureAs1000px() {
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
		left: 0,
		top: 0,
		right: 1000,
		bottom: 40,
		width: 1000,
		height: 40,
		x: 0,
		y: 0,
		toJSON: () => ({}),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	localStorage.setItem(LOCALE_STORAGE_KEY, "ko-KR");
	useProjectStore.setState({ projectId: "p", document: project(), saveDocument: save });
	useComposeStore.setState({ ...initialCompose, applying: null, apply });
	useMediaPreview.setState({ timeSec: 0, playing: false, controls: null });
	Object.defineProperty(window, "electronAPI", { configurable: true, value: api });
	api.vclipThumbnail.mockResolvedValue({ success: true, dataUrl: "data:image/jpeg;base64,AA==" });
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	useProjectStore.setState(initialProject);
	useComposeStore.setState(initialCompose);
});

describe("Media's library", () => {
	it("opens on V.Clip's clips, in filmed order, and adds them to the timeline with the chosen effect", async () => {
		renderMedia();
		expect(screen.getByRole("tab", { name: /V\.Clip 클립 2/ })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		const cards = screen.getAllByRole("article");
		expect(within(cards[0]).getByText("0:00.0–0:04.0")).toBeInTheDocument();
		expect(within(cards[1]).getByText("절벽을 돌아")).toBeInTheDocument();

		fireEvent.change(screen.getByLabelText("새 항목 효과"), { target: { value: "zoom-in" } });
		fireEvent.click(screen.getByRole("button", { name: /모두 타임라인에 추가/ }));
		await waitFor(() => expect(board().items).toHaveLength(2));
		expect(board().items.map((item) => [item.startSec, item.effect])).toEqual([
			[0, "zoom-in"],
			[10, "zoom-in"],
		]);
		expect(localStorage.getItem("donqui.media.defaultEffect")).toBe("zoom-in");
		expect(blocks()).toHaveLength(2);
		// The first one added is selected, and the preview goes to it.
		expect(screen.getByRole("region", { name: "항목 설정" })).toBeInTheDocument();
	});

	it("adds photos by their original files, sized, and places them at the photo length", async () => {
		api.openImageFilesPicker.mockResolvedValue({
			success: true,
			files: [{ path: "C:/photos/sea.jpg", name: "sea.jpg" }],
			rejected: [],
		});
		renderMedia();
		fireEvent.click(screen.getByRole("tab", { name: /사진 0/ }));
		fireEvent.click(screen.getByRole("button", { name: "사진 추가" }));
		await waitFor(() => expect(board().images).toHaveLength(1));
		expect(board().images[0]).toMatchObject({
			path: "C:/photos/sea.jpg",
			label: "sea.jpg",
			width: 4000,
			height: 3000,
		});
		fireEvent.change(screen.getByLabelText("사진 길이 (초)"), { target: { value: "3.5" } });
		fireEvent.click(screen.getByRole("button", { name: "타임라인에 추가" }));
		await waitFor(() => expect(board().items).toHaveLength(1));
		expect(board().items[0]).toMatchObject({ kind: "image", startSec: 0, endSec: 3.5 });
	});

	it("hands a video to V.Clip, and puts a whole one on the timeline", async () => {
		renderMedia();
		fireEvent.click(screen.getByRole("tab", { name: /영상 1/ }));
		fireEvent.click(screen.getByRole("button", { name: "DJI_0017.MP4 V.Clip에서 나누기" }));
		expect(onOpenInVClip).toHaveBeenCalledWith("drone");
		fireEvent.click(screen.getByRole("button", { name: /전체 추가/ }));
		await waitFor(() => expect(board().items).toHaveLength(1));
		expect(board().items[0]).toMatchObject({ kind: "video", startSec: 0, endSec: 60 });
	});

	it("drops a card onto the timeline where it was let go", async () => {
		const document = useProjectStore.getState().document as AxcutDocument;
		const clips = boardOf(document).clips;
		useProjectStore.setState({
			document: addBoardItems(document, [
				clipItem(clips[1], { effect: "none" }),
				clipItem(clips[0], { effect: "none" }),
			]),
		});
		renderMedia();
		measureAs1000px();
		const lane = within(timeline()).getByLabelText("영상·사진 줄");
		// jsdom has no DragEvent: a mouse event of the same name carries clientX, and the card's
		// data is attached the way a browser would.
		const drag = (type: string, clientX: number) => {
			const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX });
			Object.defineProperty(event, "dataTransfer", {
				value: {
					types: ["application/x-donqui-media"],
					getData: () => JSON.stringify({ kind: "clip", id: clips[1].id }),
					dropEffect: "none",
				},
			});
			return event;
		};
		// 9 s of items under 12 s of music, in a 15 s view: 100 px is 1.5 s, in the first item's
		// first half — the drop goes before it.
		fireEvent(lane, drag("dragover", 100));
		fireEvent(lane, drag("drop", 100));
		await waitFor(() => expect(board().items).toHaveLength(3));
		expect(board().items.map((item) => item.startSec)).toEqual([0, 0, 10]);
	});
});

describe("Media's timeline", () => {
	function composed() {
		const document = project();
		const clips = boardOf(document).clips;
		const photos = addBoardImages(document, [
			{ path: "C:/photos/sea.jpg", label: "sea.jpg", width: 4000, height: 3000 },
		]);
		useProjectStore.setState({
			document: addBoardItems(photos.document, [
				clipItem(clips[1], { effect: "none" }),
				clipItem(clips[0], { effect: "random", seed: "fixed" }),
			]),
		});
	}

	it("lays the items out under the audio, and changes one's length, effect and place", async () => {
		composed();
		renderMedia();
		expect(blocks().map((block) => block.getAttribute("aria-label"))).toEqual([
			"1번 DJI · 0:00.0–0:04.0",
			"2번 DJI · 0:10.0–0:15.0",
		]);
		clickBlock(/^1번/);
		const inspector = screen.getByRole("region", { name: "항목 설정" });
		const length = within(inspector).getByLabelText("길이 (초)");
		fireEvent.change(length, { target: { value: "6" } });
		fireEvent.blur(length);
		await waitFor(() => expect(board().items[0]).toMatchObject({ startSec: 0, endSec: 6 }));

		fireEvent.change(within(inspector).getByLabelText("항목 효과"), {
			target: { value: "pan-left" },
		});
		await waitFor(() => expect(board().items[0].effect).toBe("pan-left"));

		fireEvent.click(within(inspector).getByRole("button", { name: "뒤로" }));
		await waitFor(() => expect(board().items[1].startSec).toBe(0));
		fireEvent.click(within(inspector).getByRole("button", { name: "빼기" }));
		await waitFor(() => expect(board().items).toHaveLength(1));
		expect(save.mock.calls.every((call) => call[1].history)).toBe(true);
	});

	it("stretches an item by dragging its end, and reorders by dragging it", async () => {
		composed();
		renderMedia();
		measureAs1000px();
		// 9 s of items against 12 s of music: a 15 s view, so 100 px is 1.5 s.
		const first = within(timeline()).getByRole("button", { name: /^1번/ });
		const end = within(first).getByLabelText("길이 조절");
		fireEvent.pointerDown(end, { clientX: 285, button: 0 });
		fireEvent.pointerMove(first, { clientX: 385 });
		fireEvent.pointerUp(first, { clientX: 385 });
		await waitFor(() => expect(itemDurationSec(board().items[0])).toBeCloseTo(5.5, 2));

		const second = within(timeline()).getByRole("button", { name: /^2번/ });
		fireEvent.pointerDown(second, { clientX: 600, button: 0 });
		fireEvent.pointerMove(second, { clientX: 100 });
		fireEvent.pointerUp(second, { clientX: 100 });
		await waitFor(() => expect(board().items[0].startSec).toBe(10));
	});

	it("selects an item with a click and shows it in the preview", () => {
		composed();
		renderMedia();
		expect(screen.getByTestId("media-preview")).toHaveTextContent(
			"1920x1080|video:none:0:120,video:tilt:10000:150|audio:0",
		);
		clickBlock(/^2번/);
		expect(within(timeline()).getByRole("button", { name: /^2번/ })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(useMediaPreview.getState().timeSec).toBeCloseTo(4, 2);
	});

	it("removes and duplicates the selected item from the keyboard", async () => {
		composed();
		renderMedia();
		clickBlock(/^1번/);
		fireEvent.keyDown(window, { key: "d", ctrlKey: true });
		await waitFor(() => expect(board().items).toHaveLength(3));
		expect(board().items.map((item) => item.startSec)).toEqual([0, 0, 10]);
		fireEvent.keyDown(window, { key: "Delete" });
		await waitFor(() => expect(board().items).toHaveLength(2));
	});

	it("fits the composition to the audio", async () => {
		composed();
		renderMedia();
		expect(within(timeline()).getByText("0:03.0 모자람")).toBeInTheDocument();
		fireEvent.click(within(timeline()).getByRole("button", { name: /Audio 길이에 맞추기/ }));
		await waitFor(() =>
			expect(board().items.reduce((sum, item) => sum + itemDurationSec(item), 0)).toBeCloseTo(12),
		);
		// 4 s and 5 s stretched together to 12 s.
		const [first, second] = board().items.map(itemDurationSec);
		expect(first).toBeCloseTo(5.333, 3);
		expect(second).toBeCloseTo(6.667, 3);
		expect(mocks.toast.success).toHaveBeenCalledWith(
			"조합을 Audio 길이 0:12.0에 맞췄습니다.",
			undefined,
		);
		expect(await within(timeline()).findByText("길이가 맞습니다")).toBeInTheDocument();
	});

	it("says so when the clips can only cover the audio by showing the same footage", async () => {
		composed();
		const current = useProjectStore.getState().document;
		if (!current) throw new Error("no document");
		// A 16 s video leaves the two clips 16 s of footage between them, short of 20 s of music.
		useProjectStore.setState({
			document: {
				...current,
				assets: [{ ...drone, durationSec: 16 }],
				audioTracks: [
					{
						...createAudioTrack({ assetId: "music", durationSec: 20, kind: "music" as const }),
						timelineLocked: true,
					},
				],
			},
		});
		renderMedia();
		fireEvent.click(within(timeline()).getByRole("button", { name: /Audio 길이에 맞추기/ }));
		await waitFor(() =>
			expect(board().items.reduce((sum, item) => sum + itemDurationSec(item), 0)).toBeCloseTo(20),
		);
		expect(mocks.toast.success).not.toHaveBeenCalled();
		expect(mocks.toast.warning).toHaveBeenCalledWith("조합을 Audio 길이 0:20.0에 맞췄습니다.", {
			description: expect.stringContaining("같은 장면을 다시 씁니다"),
		});
	});

	it("puts the Audio tab's mix on the top row, and says when its clips changed since", async () => {
		const audio = (id: string, durationSec: number) => ({
			id,
			kind: "audio" as const,
			label: `${id}.mp3`,
			originalPath: `C:/audio/${id}.mp3`,
			durationSec,
			cameraTrack: null,
		});
		const layered = addLayers(
			{ ...project(), assets: [drone, audio("song", 12), audio("voice", 5)], audioTracks: [] },
			[
				{ assetId: "song", kind: "music", label: "", durationSec: 12 },
				{ assetId: "voice", kind: "voiceover", label: "", durationSec: 5 },
			],
		).document;
		const applied = applyMix(
			{ ...layered, assets: [...layered.assets, audio("mix", 12)] },
			{ assetId: "mix", durationSec: 12, signature: mixSignature(mixSpec(layered)) },
		);
		useProjectStore.setState({ document: applied });
		renderMedia();
		const audioRow = within(timeline()).getByLabelText("Audio 줄");
		expect(within(audioRow).getByText("오디오 믹스 · 0:12.0")).toBeInTheDocument();
		expect(within(timeline()).getByText("Media에 반영됨")).toBeInTheDocument();
		expect(within(composition()).queryByRole("status")).not.toBeInTheDocument();
		const song = audioBoardOf(applied).layers[0];
		act(() =>
			useProjectStore.setState({ document: updateLayer(applied, song.id, { volume: 40 }) }),
		);
		expect(await within(composition()).findByRole("status")).toHaveTextContent(
			"Audio 탭에서 바꾼 오디오가 아직 반영되지 않았습니다.",
		);
		expect(within(timeline()).getByText("Audio 탭에 바뀐 내용이 있습니다")).toBeInTheDocument();
	});

	it("offers cuts on the narration's pauses once it is transcribed", () => {
		const document = project();
		document.audioTracks.push({
			...createAudioTrack({ assetId: "voice", durationSec: 10, kind: "voiceover" }),
			timelineLocked: true,
		});
		document.transcripts = [
			{
				assetId: "voice",
				language: "ko",
				segments: [],
				words: [
					{ id: "a", segmentId: "s", startSec: 1, endSec: 2, text: "안녕" },
					{ id: "b", segmentId: "s", startSec: 3, endSec: 4, text: "하세요" },
				],
			},
		];
		useProjectStore.setState({ document });
		renderMedia();
		// Before the first word, between the two, and after the last.
		expect(screen.getByLabelText(/나레이션이 쉬는 곳에 컷 맞추기 \(3곳\)/)).toBeChecked();
	});

	it("applies straight onto an empty Edit timeline, and asks before replacing a full one", async () => {
		composed();
		const { unmount } = renderMedia();
		fireEvent.click(screen.getByRole("button", { name: /Edit에 반영/ }));
		expect(apply).toHaveBeenCalledWith("replace");
		unmount();

		const document = useProjectStore.getState().document as AxcutDocument;
		useProjectStore.setState({
			document: {
				...document,
				timeline: {
					...document.timeline,
					clips: [
						{
							id: "old",
							assetId: "drone",
							sourceStartSec: 0,
							sourceEndSec: 3,
							timelineStartSec: 0,
							timelineEndSec: 3,
							wordRefs: [],
							origin: "user",
							reason: "",
						},
					],
				},
			},
		});
		apply.mockClear();
		renderMedia();
		fireEvent.click(screen.getByRole("button", { name: /Edit에 반영/ }));
		expect(apply).not.toHaveBeenCalled();
		const confirm = screen.getByRole("alertdialog", { name: "Edit 타임라인 바꾸기" });
		expect(within(confirm).getByText(/클립 1개를 이 조합으로 바꿉니다/)).toBeInTheDocument();
		fireEvent.click(within(confirm).getByRole("button", { name: "바꾸기" }));
		expect(apply).toHaveBeenCalledWith("replace");
		fireEvent.click(screen.getByRole("button", { name: "Edit 끝에 추가" }));
		expect(apply).toHaveBeenLastCalledWith("append");
	});

	it("shows the renders in progress, holds the composition still, and stops on request", () => {
		composed();
		const cancel = vi.fn();
		useComposeStore.setState({
			applying: { mode: "replace", done: 1, total: 3, label: "sea.jpg" },
			cancel,
		});
		renderMedia();
		expect(screen.getByText("렌더링 2 / 3 · sea.jpg")).toBeInTheDocument();
		expect(within(timeline()).getByRole("button", { name: /Audio 길이에 맞추기/ })).toBeDisabled();
		clickBlock(/^1번/);
		expect(screen.getByLabelText("항목 효과")).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: /멈추기/ }));
		expect(cancel).toHaveBeenCalled();
	});
});
