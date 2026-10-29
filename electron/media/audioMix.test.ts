import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getAppPath: () => process.cwd(), isPackaged: false } }));

import {
	audioMixArgs,
	MAX_MIX_LAYERS,
	parseAudioChannels,
	parsePeakDb,
	validateMixRequest,
} from "./audioMix";

const music = {
	path: "C:/audio/song.mp3",
	startSec: 0,
	inSec: 1,
	outSec: 9,
	gain: 0.5,
	fadeInSec: 1,
	fadeOutSec: 2,
};
const narration = {
	path: "C:/audio/voice.wav",
	startSec: 2.5,
	inSec: 0.5,
	outSec: 5.5,
	gain: 2,
	fadeInSec: 0,
	fadeOutSec: 0,
};

describe("a mix request", () => {
	it("passes with layers that can be mixed and the length they add up to", () => {
		expect(validateMixRequest({ layers: [music, narration], durationSec: 8 })).toEqual({
			layers: [music, narration],
			durationSec: 8,
		});
	});

	it("is refused for anything the renderer should not be able to ask", () => {
		const bad = [
			null,
			{ layers: [], durationSec: 1 },
			{ layers: Array(MAX_MIX_LAYERS + 1).fill(music), durationSec: 8 },
			{ layers: [{ ...music, path: "" }], durationSec: 8 },
			{ layers: [{ ...music, outSec: 1 }], durationSec: 0.01 },
			{ layers: [{ ...music, startSec: -1 }], durationSec: 7 },
			{ layers: [{ ...music, gain: 5 }], durationSec: 8 },
			{ layers: [{ ...music, gain: Number.NaN }], durationSec: 8 },
			{ layers: [{ ...music, fadeInSec: 5, fadeOutSec: 4 }], durationSec: 8 },
			{ layers: [music], durationSec: 20 },
		];
		for (const request of bad) expect(() => validateMixRequest(request)).toThrow();
	});
});

describe("the mix's ffmpeg command", () => {
	it("trims, levels, fades and places each layer, then sums them to the exact length", () => {
		const args = audioMixArgs({ layers: [music, narration], durationSec: 8 }, [2, 1], "out.wav");
		const graph = args[args.indexOf("-filter_complex") + 1].split(";");
		expect(graph[0]).toBe(
			"[0:a:0]atrim=start=1:end=9,asetpts=PTS-STARTPTS,aresample=48000," +
				"aformat=channel_layouts=stereo,aformat=sample_fmts=fltp,volume=0.5," +
				"afade=t=in:st=0:d=1:curve=tri,afade=t=out:st=6:d=2:curve=tri," +
				"adelay=delays=0S:all=1[l0]",
		);
		// Mono goes to both sides at full level; the delay is in samples.
		expect(graph[1]).toBe(
			"[1:a:0]atrim=start=0.5:end=5.5,asetpts=PTS-STARTPTS,aresample=48000," +
				"pan=stereo|c0=c0|c1=c0,aformat=sample_fmts=fltp,volume=2," +
				"adelay=delays=120000S:all=1[l1]",
		);
		expect(graph[2]).toBe(
			"[l0][l1]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0," +
				"apad=whole_dur=8,atrim=end=8,astats=metadata=0[mix]",
		);
		expect(args.slice(args.indexOf("-map"))).toEqual([
			"-map",
			"[mix]",
			"-c:a",
			"pcm_s16le",
			"-ar",
			"48000",
			"-ac",
			"2",
			"out.wav",
		]);
		expect(args.filter((arg, index) => args[index - 1] === "-i")).toEqual([
			music.path,
			narration.path,
		]);
	});
});

describe("ffmpeg's reports", () => {
	it("read the first audio stream's channels", () => {
		const probe = (stream: string) =>
			`Input #0, wav, from 'a.wav':\n  Duration: 00:00:06.00, bitrate: 705 kb/s\n  ${stream}\n`;
		expect(
			parseAudioChannels(probe("Stream #0:0: Audio: pcm_s16le, 44100 Hz, mono, s16, 705 kb/s")),
		).toBe(1);
		expect(
			parseAudioChannels(probe("Stream #0:0: Audio: mp3 (mp3float), 48000 Hz, stereo, fltp")),
		).toBe(2);
		expect(parseAudioChannels(probe("Stream #0:0: Audio: aac, 48000 Hz, 5.1(side), fltp"))).toBe(6);
		expect(parseAudioChannels(probe("Stream #0:0: Audio: opus, 48000 Hz, 4 channels, fltp"))).toBe(
			4,
		);
		expect(parseAudioChannels(probe("Stream #0:0: Video: h264, 1920x1080"))).toBeNull();
	});

	it("read the overall peak astats prints last, past 0 dB", () => {
		const stats =
			"[Parsed_astats_0] Channel: 1\n[Parsed_astats_0] Peak level dB: 0.252942\n" +
			"[Parsed_astats_0] Channel: 2\n[Parsed_astats_0] Peak level dB: -1.5\n" +
			"[Parsed_astats_0] Overall\n[Parsed_astats_0] Peak level dB: 0.252942\n";
		expect(parsePeakDb(stats)).toBeCloseTo(0.252942);
		expect(parsePeakDb("[Parsed_astats_0] Overall\nPeak level dB: -inf\n")).toBeNull();
		expect(parsePeakDb("nothing")).toBeNull();
	});
});
