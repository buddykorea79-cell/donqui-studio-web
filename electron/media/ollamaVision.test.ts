import { describe, expect, it, vi } from "vitest";
import {
	analyzeSegmentFrames,
	listVisionModels,
	OLLAMA_DEFAULT_BASE_URL,
	OLLAMA_NUM_CTX,
	parseJsonObject,
	parseProposal,
	resolveOllamaBaseUrl,
	withPrefill,
} from "./ollamaVision";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("resolveOllamaBaseUrl", () => {
	it.each([
		[undefined, OLLAMA_DEFAULT_BASE_URL],
		["", OLLAMA_DEFAULT_BASE_URL],
		["127.0.0.1", "http://127.0.0.1:11434"],
		["localhost:11500", "http://localhost:11500"],
		["0.0.0.0", "http://127.0.0.1:11434"],
		["http://127.0.0.1:8080", "http://127.0.0.1:8080"],
		["[::1]:11434", "http://[::1]:11434"],
	])("reads OLLAMA_HOST %j as %s", (host, expected) => {
		expect(resolveOllamaBaseUrl(host)).toBe(expected);
	});

	it.each([
		"http://192.168.0.10:11434",
		"ollama.example.com",
		"ftp://127.0.0.1",
		"http://[bad",
	])("never sends frames off the machine: %s falls back to loopback", (host) => {
		expect(resolveOllamaBaseUrl(host)).toBe(OLLAMA_DEFAULT_BASE_URL);
	});
});

describe("listVisionModels", () => {
	it("keeps only models that can see images, lightest first", async () => {
		const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			if (String(url).endsWith("/api/tags"))
				return json({
					models: [
						{ name: "qwen3-vl:8b", size: 6_000, details: { parameter_size: "8.8B" } },
						{ name: "llama3:8b", size: 4_000 },
						{ name: "qwen3-vl:4b", size: 3_000, details: { parameter_size: "4.4B" } },
					],
				});
			const model = JSON.parse(String(init?.body)).model as string;
			return json({
				capabilities: model.startsWith("qwen3-vl") ? ["completion", "vision"] : ["completion"],
			});
		});
		const list = await listVisionModels("http://127.0.0.1:11434", fetcher as typeof fetch);
		expect(list).toEqual({
			available: true,
			baseUrl: "http://127.0.0.1:11434",
			error: null,
			models: [
				{ name: "qwen3-vl:4b", size: 3_000, parameterSize: "4.4B" },
				{ name: "qwen3-vl:8b", size: 6_000, parameterSize: "8.8B" },
			],
		});
	});

	it("reports an unreachable server instead of throwing", async () => {
		const refused = Object.assign(new TypeError("fetch failed"), {
			cause: new Error("connect ECONNREFUSED 127.0.0.1:11434"),
		});
		const list = await listVisionModels("http://127.0.0.1:11434", (async () => {
			throw refused;
		}) as typeof fetch);
		expect(list.available).toBe(false);
		expect(list.models).toEqual([]);
		expect(list.error).toContain("ECONNREFUSED");
	});
});

describe("parsing the model's answer", () => {
	it("takes the object out of fences and prose", () => {
		expect(parseJsonObject('Sure:\n```json\n{"score": 70}\n```')).toEqual({ score: 70 });
		expect(parseJsonObject('The answer is {"a": "}"} as asked.')).toEqual({ a: "}" });
		expect(() => parseJsonObject("no object here")).toThrow(/no JSON object/);
	});

	it("reads Qwen3-VL's answer from `thinking` when `content` is empty", () => {
		const proposal = parseProposal({
			content: "",
			thinking:
				'{"score": 81, "category": "orbit", "description": "해안선", "caption": "바다", "tags": ["Sea"]}',
		});
		expect(proposal).toEqual({
			score: 81,
			category: "orbit",
			description: "해안선",
			caption: "바다",
			tags: ["sea"],
		});
	});

	it("normalises instead of rejecting a small model's slips", () => {
		const proposal = parseProposal({
			content: JSON.stringify({
				score: "140",
				category: "sunset",
				description: "  넓은   들판  ",
				tags: ["a", "A", " ", "b", "c", "d", "e", "f", "g"],
			}),
		});
		expect(proposal.score).toBe(100);
		expect(proposal.category).toBe("general");
		expect(proposal.description).toBe("넓은 들판");
		expect(proposal.caption).toBe("");
		expect(proposal.tags).toEqual(["a", "b", "c", "d", "e", "f"]);
	});

	it("rejects an answer without a score", () => {
		expect(() => parseProposal({ content: '{"category": "orbit"}' })).toThrow(
			/not a segment judgement/,
		);
	});
});

describe("analyzeSegmentFrames", () => {
	const request = {
		baseUrl: "http://127.0.0.1:11434",
		model: "qwen3-vl:4b",
		frames: [Buffer.from("one"), Buffer.from("two")],
		title: "DJI_0017.MP4\u0007",
		durationSec: 5,
	};

	it("asks for a schema-shaped answer with the frames and a small context", async () => {
		const fetcher = vi.fn(async () =>
			json({
				message: {
					content:
						'{"score": 64, "category": "action", "description": "d", "caption": "c", "tags": []}',
				},
			}),
		);
		const proposal = await analyzeSegmentFrames(request, undefined, fetcher as typeof fetch);
		expect(proposal.score).toBe(64);
		const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("http://127.0.0.1:11434/api/chat");
		const body = JSON.parse(String(init.body));
		expect(body.model).toBe("qwen3-vl:4b");
		expect(body.stream).toBe(false);
		expect(body.options.num_ctx).toBe(OLLAMA_NUM_CTX);
		expect(body.format.required).toContain("score");
		expect(body.messages[0].images).toEqual([
			Buffer.from("one").toString("base64"),
			Buffer.from("two").toString("base64"),
		]);
		// Control characters in a file name never reach the prompt.
		expect(body.messages[0].content).not.toContain("\u0007");
		// The answer is started for the model, so a thinking model answers instead of reasoning.
		expect(body.messages[1]).toEqual({ role: "assistant", content: "{" });
	});

	it("completes a reply that continues the prefilled brace", async () => {
		const fetcher = vi.fn(async () =>
			json({
				message: {
					content:
						' "score": 85, "category": "static_beauty", "description": "호수 위 건물", "caption": "물 위의 집", "tags": "water, building" }',
				},
			}),
		);
		const proposal = await analyzeSegmentFrames(request, undefined, fetcher as typeof fetch);
		expect(proposal).toEqual({
			score: 85,
			category: "static_beauty",
			description: "호수 위 건물",
			caption: "물 위의 집",
			tags: ["water", "building"],
		});
	});

	it("keeps an empty reply empty, so the failure says so", async () => {
		const fetcher = vi.fn(async () => json({ message: { content: "", thinking: "" } }));
		await expect(analyzeSegmentFrames(request, undefined, fetcher as typeof fetch)).rejects.toThrow(
			"(empty reply)",
		);
		expect(withPrefill({ content: "  " })).toEqual({ content: "  " });
		expect(withPrefill({ content: '{"score": 1}' })).toEqual({ content: '{"score": 1}' });
	});

	it("surfaces Ollama's own error text", async () => {
		const fetcher = async () => new Response("model 'x' not found", { status: 404 });
		await expect(analyzeSegmentFrames(request, undefined, fetcher as typeof fetch)).rejects.toThrow(
			/HTTP 404: model 'x' not found/,
		);
	});

	it("refuses to send no frames or too many", async () => {
		const fetcher = vi.fn();
		await expect(
			analyzeSegmentFrames({ ...request, frames: [] }, undefined, fetcher as typeof fetch),
		).rejects.toThrow(/one to four frames/);
		expect(fetcher).not.toHaveBeenCalled();
	});
});
