import { z } from "zod";
import {
	VCLIP_CATEGORY_IDS,
	type VClipAiProposal,
	type VClipCategory,
	type VClipModelList,
} from "../../src/lib/vclip/contract";

/**
 * A local Ollama vision model judging V.Clip segments — AutoVeo's
 * `apps/server/src/services/ollama.ts`, narrowed to the one question V.Clip asks: "is this
 * window of footage worth using, and what is in it?".
 *
 * Only a loopback server is ever contacted, so frames of the user's footage never leave the
 * machine even when OLLAMA_HOST points elsewhere.
 */

export const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";

/**
 * Three 768px frames take ~3,300 prompt tokens. A 4,096-token context holds them plus the
 * answer; leaving the server's own default (16K on recent builds) in place grows the KV cache
 * enough to push an 8B model partly onto the CPU of an 8 GB GPU — measured 27 s instead of
 * 1.4 s (4B) per segment.
 */
export const OLLAMA_NUM_CTX = 4096;

const LIST_TIMEOUT_MS = 5_000;
const ANALYZE_TIMEOUT_MS = 120_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

type Fetcher = typeof fetch;

/**
 * Ollama's own OLLAMA_HOST convention: `host[:port]` or `scheme://host[:port]`, 11434 when a
 * bare host has no port. `0.0.0.0` means "listen everywhere" to the server, so the client
 * reaches it on loopback. Anything that is not loopback falls back to the default.
 */
export function resolveOllamaBaseUrl(host: string | undefined = process.env.OLLAMA_HOST): string {
	const raw = host?.trim();
	if (!raw) return OLLAMA_DEFAULT_BASE_URL;
	const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
	try {
		const url = new URL(hasScheme ? raw : `http://${raw}`);
		if (url.protocol !== "http:" && url.protocol !== "https:") return OLLAMA_DEFAULT_BASE_URL;
		if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
		if (!LOOPBACK_HOSTS.has(url.hostname)) return OLLAMA_DEFAULT_BASE_URL;
		if (!hasScheme && !url.port) url.port = "11434";
		return `${url.protocol}//${url.host}`;
	} catch {
		return OLLAMA_DEFAULT_BASE_URL;
	}
}

const tagsSchema = z.object({
	models: z.array(
		z.looseObject({
			name: z.string().min(1),
			size: z.number().nonnegative().optional(),
			details: z.looseObject({ parameter_size: z.string().optional() }).optional(),
		}),
	),
});

const showSchema = z.looseObject({ capabilities: z.array(z.string()).optional() });

const chatSchema = z.looseObject({
	message: z.looseObject({
		content: z.string().default(""),
		thinking: z.string().nullish(),
	}),
});

const proposalShape = z.looseObject({
	score: z.coerce.number(),
	category: z.string().optional(),
	description: z.string().optional(),
	caption: z.string().optional(),
	// Without a schema a model may list its tags in one string: "water, building".
	tags: z.union([z.array(z.string()), z.string()]).optional(),
});

/** Constrains the model's sampling to the answer's shape (Ollama structured outputs). */
const PROPOSAL_JSON_SCHEMA = {
	type: "object",
	properties: {
		score: { type: "integer", minimum: 0, maximum: 100 },
		category: { type: "string", enum: VCLIP_CATEGORY_IDS },
		description: { type: "string" },
		caption: { type: "string" },
		tags: { type: "array", items: { type: "string" } },
	},
	required: ["score", "category", "description", "caption", "tags"],
};

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		// Node's fetch reports a refused connection as "fetch failed" with the reason in `cause`.
		const cause = (error as Error & { cause?: unknown }).cause;
		return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
	}
	return String(error);
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function capabilities(baseUrl: string, model: string, fetcher: Fetcher): Promise<string[]> {
	const response = await fetcher(`${baseUrl}/api/show`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model }),
		signal: withTimeout(undefined, LIST_TIMEOUT_MS),
	});
	if (!response.ok) return [];
	return showSchema.parse(await response.json()).capabilities ?? [];
}

/** Installed models that can see images, lightest first (the fastest is the default). */
export async function listVisionModels(
	baseUrl: string,
	fetcher: Fetcher = fetch,
): Promise<VClipModelList> {
	try {
		const response = await fetcher(`${baseUrl}/api/tags`, {
			signal: withTimeout(undefined, LIST_TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status} for its model list`);
		const tags = tagsSchema.parse(await response.json());
		const checked = await Promise.all(
			tags.models.map(async (model) => ({
				model,
				vision: (await capabilities(baseUrl, model.name, fetcher)).includes("vision"),
			})),
		);
		const models = checked
			.filter((entry) => entry.vision)
			.map(({ model }) => ({
				name: model.name,
				size: model.size ?? 0,
				parameterSize: model.details?.parameter_size ?? null,
			}))
			.sort((left, right) => left.size - right.size || left.name.localeCompare(right.name));
		return { available: true, baseUrl, error: null, models };
	} catch (error) {
		return { available: false, baseUrl, error: errorMessage(error), models: [] };
	}
}

export interface SegmentFramesRequest {
	baseUrl: string;
	model: string;
	/** JPEG frames of one window, in time order (one to four). */
	frames: Buffer[];
	title: string;
	durationSec: number;
}

function segmentPrompt(title: string, durationSec: number): string {
	// A file name is the only free text reaching the prompt; keep it to one short line.
	const safeTitle = title.replace(/[\p{Cc}]+/gu, " ").slice(0, 120);
	return [
		"당신은 영상 편집자입니다. 입력 이미지는 같은 영상 구간에서 시간 순서대로 뽑은 대표 프레임입니다.",
		"보이는 것만 근거로 판단하고, 장소명·인물 관계·사건을 지어내지 마세요.",
		"score: 이 구간을 최종 영상에 쓸 가치. 0~100 사이에서 변별력 있게 매기세요. 흐리거나 어둡거나 흔들리거나 의미 없는 장면은 낮게 줍니다.",
		`category: ${VCLIP_CATEGORY_IDS.join(" | ")} 중 하나.`,
		"description: 무엇이 보이는지 한국어 60자 이내로.",
		"caption: 영상에 얹을 한국어 자막 초안. 22자 이하 한 문장. 확인 가능한 내용만.",
		"tags: 영어 소문자 키워드 최대 6개.",
		"설명이나 코드펜스 없이 JSON 객체 하나만 출력하세요.",
		`구간 정보: 파일=${safeTitle} 길이=${durationSec.toFixed(1)}초`,
	].join("\n");
}

/** Asks the model to judge one window from its frames. Throws when there is no usable answer. */
export async function analyzeSegmentFrames(
	request: SegmentFramesRequest,
	signal?: AbortSignal,
	fetcher: Fetcher = fetch,
): Promise<VClipAiProposal> {
	if (request.frames.length === 0 || request.frames.length > 4)
		throw new Error("A segment is judged from one to four frames");
	const response = await fetcher(`${request.baseUrl}/api/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: request.model,
			messages: [
				{
					role: "user",
					content: segmentPrompt(request.title, request.durationSec),
					images: request.frames.map((frame) => frame.toString("base64")),
				},
				// The answer is started for the model, which it continues. Qwen3-VL on Ollama 0.34
				// ignores `think: false` and reasons past `num_predict`, leaving neither `content`
				// nor `thinking` with the object (measured: every window of three DJI clips). A
				// reply that is already under way is answered directly — in ~1.3 s, not 4 s.
				{ role: "assistant", content: "{" },
			],
			format: PROPOSAL_JSON_SCHEMA,
			stream: false,
			think: false,
			options: { temperature: 0.2, num_predict: 320, num_ctx: OLLAMA_NUM_CTX },
		}),
		signal: withTimeout(signal, ANALYZE_TIMEOUT_MS),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(
			`Ollama returned HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
		);
	}
	return parseProposal(withPrefill(chatSchema.parse(await response.json()).message));
}

/**
 * The reply to a prefilled `{`: with a schema Ollama returns the whole object, without one only
 * what follows the brace. Either way the object comes back whole; an empty reply stays empty.
 */
export function withPrefill(message: { content: string; thinking?: string | null }): {
	content: string;
	thinking?: string | null;
} {
	const content = message.content.trimStart();
	return content && !content.startsWith("{") ? { ...message, content: `{${content}` } : message;
}

function stripCodeFences(text: string): string {
	return /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text)?.[1]?.trim() ?? text;
}

function balancedObject(text: string): string | null {
	const start = text.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
		} else if (char === '"') inString = true;
		else if (char === "{") depth++;
		else if (char === "}" && --depth === 0) return text.slice(start, index + 1);
	}
	return null;
}

/** The first JSON object in a model's reply, tolerating fences and prose around it. */
export function parseJsonObject(text: string): unknown {
	for (const candidate of [text, stripCodeFences(text)]) {
		const trimmed = candidate.trim();
		if (!trimmed) continue;
		try {
			return JSON.parse(trimmed);
		} catch {
			// Prose around the object: cut the object out below.
		}
		const object = balancedObject(trimmed);
		if (object) {
			try {
				return JSON.parse(object);
			} catch {
				// Fall through to the next candidate.
			}
		}
	}
	throw new Error(
		`Ollama's reply holds no JSON object${text.trim() ? `: ${text.trim().slice(0, 200)}` : " (empty reply)"}`,
	);
}

function clip(text: string | undefined, max: number): string {
	return (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Qwen3-VL on Ollama 0.34 answers in `thinking` with an empty `content` even with
 * `think: false`, so the object is taken from whichever field holds one (as AutoVeo does).
 * Values are normalised rather than rejected: a small model's off-list category or stray
 * whitespace should not cost the user the whole judgement.
 */
export function parseProposal(message: {
	content: string;
	thinking?: string | null;
}): VClipAiProposal {
	const content = message.content.trim();
	const thinking = (message.thinking ?? "").trim();
	const text = content.includes("{") || !thinking.includes("{") ? content : thinking;
	const raw = parseJsonObject(text);
	const shape = proposalShape.safeParse(raw);
	if (!shape.success || !Number.isFinite(shape.data.score))
		throw new Error(
			`Ollama's reply is not a segment judgement: ${JSON.stringify(raw).slice(0, 200)}`,
		);
	const category = VCLIP_CATEGORY_IDS.includes(shape.data.category as VClipCategory)
		? (shape.data.category as VClipCategory)
		: "general";
	const tags = [
		...new Set(
			(typeof shape.data.tags === "string"
				? shape.data.tags.split(/[,#\s]+/)
				: (shape.data.tags ?? [])
			)
				.map((tag) => clip(tag, 20).toLowerCase())
				.filter((tag) => tag.length > 0),
		),
	].slice(0, 6);
	return {
		score: Math.round(Math.max(0, Math.min(100, shape.data.score))),
		category,
		description: clip(shape.data.description, 120),
		caption: clip(shape.data.caption, 44),
		tags,
	};
}
