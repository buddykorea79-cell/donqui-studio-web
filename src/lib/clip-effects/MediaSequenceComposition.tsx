import { AbsoluteFill, Audio, Sequence } from "remotion";
import { ClipEffectComposition } from "./ClipEffectComposition";
import type { ClipEffectId, ClipFit, ClipSourceKind } from "./catalog";

/** One item of Media's composition, placed in frames. */
export interface SequencePart {
	id: string;
	sourceUrl: string;
	sourceKind: ClipSourceKind;
	/** Where in its source a clip starts; a photo ignores it. */
	startMs: number;
	from: number;
	frames: number;
	effect: ClipEffectId;
}

export interface MediaSequenceProps {
	parts: SequencePart[];
	/** The soundtrack, played from 0 as the programme plays it. */
	audio: Array<{ id: string; url: string; from: number; frames: number; startFrom: number }>;
	fit: ClipFit;
}

/**
 * Media's whole composition as one Remotion composition, for its preview: each item in its
 * place with the effect it will be rendered with, over the soundtrack. The same component the
 * render uses draws each item, so the preview shows what applying will make.
 */
export function MediaSequenceComposition({ parts, audio, fit }: MediaSequenceProps) {
	return (
		<AbsoluteFill style={{ backgroundColor: "black" }}>
			{parts.map((part) => (
				<Sequence
					key={part.id}
					from={part.from}
					durationInFrames={part.frames}
					premountFor={15}
					name={part.id}
				>
					<ClipEffectComposition
						sourceUrl={part.sourceUrl}
						sourceKind={part.sourceKind}
						startMs={part.startMs}
						effect={part.effect}
						fit={fit}
						durationInFrames={part.frames}
					/>
				</Sequence>
			))}
			{audio.map((track) => (
				<Sequence key={track.id} from={track.from} durationInFrames={track.frames} layout="none">
					<Audio src={track.url} trimBefore={track.startFrom} />
				</Sequence>
			))}
		</AbsoluteFill>
	);
}
