import type { AxcutDocument } from "../schema";
import { collapseTracksToPills, placeAudioTrackInDocument } from "./audioTracks";
import { createId } from "./ids";

export interface AudioTrackEdit {
	startSec: number;
	inSec: number;
	outSec: number;
	gainDb: number;
}

/** A trim and placement are one edit, so undo restores both together. */
export function editAudioFirstTrack(
	document: AxcutDocument,
	trackId: string,
	edit: AudioTrackEdit,
): AxcutDocument {
	const track = collapseTracksToPills(document.audioTracks).find((item) => item.id === trackId);
	if (!track) return document;
	const asset = document.assets.find((item) => item.id === track.assetId);
	const sourceDuration = asset?.durationSec ?? track.durationSec;
	if (
		!Object.values(edit).every(Number.isFinite) ||
		edit.startSec < 0 ||
		edit.inSec < 0 ||
		edit.outSec <= edit.inSec ||
		(sourceDuration > 0 && edit.outSec > sourceDuration + 0.001) ||
		edit.gainDb < -60 ||
		edit.gainDb > 12
	) {
		throw new Error("시작·종료 시간을 확인해 주세요. 오디오 파일 길이를 넘을 수 없습니다.");
	}
	return placeAudioTrackInDocument(
		document,
		{
			...track,
			startMs: Math.round(edit.startSec * 1000),
			endMs: Math.round((edit.startSec + edit.outSec - edit.inSec) * 1000),
			offsetMs: Math.round(edit.inSec * 1000),
			gainDb: edit.gainDb,
			loop: false,
		},
		() => createId("audio"),
		"move",
	);
}

export function audioProgrammeDuration(document: AxcutDocument | null): number {
	return document?.audioTracks.reduce((end, track) => Math.max(end, track.endMs / 1000), 0) ?? 0;
}
