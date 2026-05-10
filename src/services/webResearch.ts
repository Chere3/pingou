export type ResearchCategory =
	| "python"
	| "javascript"
	| "typescript"
	| "react"
	| "nodejs"
	| "rust"
	| "go"
	| "java"
	| "css"
	| "html"
	| "database"
	| "general";

export interface ResearchResult {
	category: ResearchCategory;
	contextForAI: string;
	sourceUrl: string;
}

const TECH_PATTERNS: Array<[ResearchCategory, RegExp]> = [
	[
		"python",
		/\bpython\b|\.py\b|\bpip\b|django|flask|fastapi|pandas|numpy|pytest|asyncio/i,
	],
	[
		"typescript",
		/\btypescript\b|\.tsx?\b|type\s+script|interface\s+\w|\benum\s+\w/i,
	],
	[
		"react",
		/\breact\b|\.jsx\b|\.tsx\b|usestate|useeffect|next\.?js|zustand|react-query/i,
	],
	[
		"nodejs",
		/node\.?js|\bnpm\b|\bbun\b(?!ny)|\bdeno\b|express|hono|fastify|elysia/i,
	],
	["rust", /\brust\b|\bcargo\b|rustup|borrow\s+checker|tokio|actix/i],
	["go", /\bgolang\b|goroutine|go\s+func|go\s+chan|\bdefer\b.*go\b/i],
	["java", /\bjava\b(?!script)|spring|maven|gradle|\bjvm\b|hibernate/i],
	[
		"css",
		/\bcss\b|tailwind(?:css)?|flexbox|\bgrid\b(?!\s+id)|sass|scss|bootstrap/i,
	],
	["html", /\bhtml\b|\bdom\b|<[a-z][a-z0-9]*[\s>]|etiqueta\s+html/i],
	[
		"database",
		/\bsql\b|postgres(?:ql)?|mysql|mongodb|redis|drizzle|prisma|\borm\b/i,
	],
	[
		"javascript",
		/\bjavascript\b|\bjs\b|es6|es20\d\d|async\/await|\bpromise\b|\bfetch\b|closure/i,
	],
];

/** Prefix used when building the search query for each tech category. */
const SEARCH_PREFIXES: Record<ResearchCategory, string> = {
	python: "python docs",
	javascript: "javascript mdn",
	typescript: "typescript docs",
	react: "react docs",
	nodejs: "nodejs docs",
	rust: "rust lang docs",
	go: "golang docs",
	java: "java docs",
	css: "css mdn",
	html: "html mdn",
	database: "sql docs",
	general: "",
};

class WebResearchService {
	private readonly JINA_BASE = "https://r.jina.ai/";
	private readonly DDG_API = "https://api.duckduckgo.com/";
	private readonly FETCH_TIMEOUT_MS = 8_000;
	private readonly MAX_CONTENT_CHARS = 3_000;

	detectCategory(query: string): ResearchCategory {
		for (const [category, pattern] of TECH_PATTERNS) {
			if (pattern.test(query)) return category;
		}
		return "general";
	}

	/**
	 * Decides whether a query is worth sending to the web research pipeline.
	 * Short or vague messages aren't worth the extra latency.
	 */
	shouldResearch(query: string): boolean {
		if (query.length < 30) return false;
		const q = query.toLowerCase();
		return (
			/error|exception|bug|undefined|cannot|typeerror|syntaxerror|importerror/.test(
				q,
			) ||
			/cómo|como\s|how\s|qué\s|que\s+es|what\s+is|cuándo|por\s+qué|why\s|when\s/.test(
				q,
			) ||
			/versión|version|v\d+\.\d+|\bapi\b|library|librería|package|módulo/.test(
				q,
			) ||
			TECH_PATTERNS.some(([, pattern]) => pattern.test(q))
		);
	}

	private async fetchWithTimeout(
		url: string,
		init?: RequestInit,
	): Promise<Response | null> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.FETCH_TIMEOUT_MS);
		try {
			return await fetch(url, { ...init, signal: controller.signal });
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
		}
	}

	private async searchDDG(query: string): Promise<string | null> {
		const url = `${this.DDG_API}?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
		const response = await this.fetchWithTimeout(url);
		if (!response?.ok) return null;

		try {
			const data = (await response.json()) as {
				AbstractURL?: string;
				RelatedTopics?: Array<{ FirstURL?: string }>;
			};
			return (
				data.AbstractURL ||
				data.RelatedTopics?.find((t) => t.FirstURL)?.FirstURL ||
				null
			);
		} catch {
			return null;
		}
	}

	private async fetchMarkdown(url: string): Promise<string | null> {
		const jinaUrl = `${this.JINA_BASE}${url}`;
		const response = await this.fetchWithTimeout(jinaUrl, {
			headers: { Accept: "text/markdown, text/plain" },
		});
		if (!response?.ok) return null;

		try {
			const text = await response.text();
			return text.slice(0, this.MAX_CONTENT_CHARS);
		} catch {
			return null;
		}
	}

	/**
	 * Main entry point. Detects the query category, searches DuckDuckGo for a
	 * relevant URL, fetches that page as clean markdown via Jina Reader, and
	 * returns a formatted context string ready to be injected into the AI prompt.
	 *
	 * Returns null when no useful result could be obtained (network error, no
	 * results, empty content, etc.) — callers should handle this gracefully and
	 * fall back to a plain AI response.
	 */
	async research(query: string): Promise<ResearchResult | null> {
		const category = this.detectCategory(query);
		const prefix = SEARCH_PREFIXES[category];
		const searchQuery = prefix ? `${prefix} ${query}` : query;

		const sourceUrl = await this.searchDDG(searchQuery);
		if (!sourceUrl) return null;

		const content = await this.fetchMarkdown(sourceUrl);
		if (!content?.trim()) return null;

		const contextForAI = [
			`[Contexto obtenido de internet — fuente: ${sourceUrl}]`,
			content,
			"[Fin del contexto web]",
		].join("\n\n");

		return { category, contextForAI, sourceUrl };
	}
}

export const webResearchService = new WebResearchService();
