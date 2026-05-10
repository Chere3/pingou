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
	sourceUrls?: string[];
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
	private readonly FETCH_TIMEOUT_MS = 8_000;
	private readonly MAX_CONTENT_CHARS = 3_000;
	private readonly MAX_CONTENT_CHARS_MULTI = 1_500;

	detectCategory(query: string): ResearchCategory {
		for (const [category, pattern] of TECH_PATTERNS) {
			if (pattern.test(query)) return category;
		}
		return "general";
	}

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

	/**
	 * Busca en DuckDuckGo Lite usando Jina Reader como intermediario.
	 * Al contrario del DDG Instant Answer API, esto hace una búsqueda web
	 * real sin autocorrecciones y devuelve hasta `maxUrls` resultados.
	 *
	 * DDG Lite codifica las URLs destino como `uddg=URL_ENCODED` en los
	 * hrefs de los resultados — los parseamos y decodificamos directamente.
	 */
	private async searchDDGLite(
		query: string,
		maxUrls = 3,
	): Promise<{ urls: string[]; snippets: string } | null> {
		const ddgUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
		const response = await this.fetchWithTimeout(`${this.JINA_BASE}${ddgUrl}`, {
			headers: { Accept: "text/plain" },
		});
		if (!response?.ok) return null;

		try {
			const text = await response.text();
			if (!text.trim()) return null;

			// Extraer URLs reales de los redirects DDG (?uddg=URL_ENCODED)
			const urls = [...text.matchAll(/uddg=([^&\s")\]]+)/g)]
				.map((m) => {
					try {
						return decodeURIComponent(m[1]);
					} catch {
						return null;
					}
				})
				.filter(
					(u): u is string =>
						!!u && u.startsWith("http") && !u.includes("duckduckgo.com"),
				)
				.slice(0, maxUrls);

			return { urls, snippets: text.slice(0, 2_000) };
		} catch {
			return null;
		}
	}

	/**
	 * Lee una URL con Jina Reader y devuelve su contenido como markdown.
	 */
	private async fetchMarkdown(
		url: string,
		maxChars: number,
	): Promise<string | null> {
		const response = await this.fetchWithTimeout(`${this.JINA_BASE}${url}`, {
			headers: { Accept: "text/markdown, text/plain" },
		});
		if (!response?.ok) return null;
		try {
			return (await response.text()).slice(0, maxChars);
		} catch {
			return null;
		}
	}

	/**
	 * Genera 2-3 variantes de búsqueda para la misma pregunta.
	 */
	generateQueries(query: string): string[] {
		const category = this.detectCategory(query);
		const prefix = SEARCH_PREFIXES[category];
		const q = query.trim().replace(/[¿¡]/g, "");
		const queries: string[] = [];

		// 1. Búsqueda principal con prefijo de tecnología
		queries.push(prefix ? `${prefix} ${q}` : q);

		// 2a. Si hay error concreto, buscar fix específico
		if (
			/error|exception|bug|crash|undefined|cannot|typeerror|syntaxerror/i.test(
				q,
			)
		) {
			queries.push(`how to fix ${q.replace(/[?]/g, "").trim()}`);
		}
		// 2b. Si es "cómo/qué es", buscar ejemplo/guía
		else if (
			/cómo|como\s|how\s|qué\s|que\s+es|what\s+is|ejemplo|example/i.test(q)
		) {
			const core = q
				.replace(/cómo|como|how to|how do|qué es|que es|what is|[?]/gi, "")
				.trim();
			if (core.length > 5) {
				queries.push(
					`${prefix ? `${prefix} ` : ""}${core} example guide`.trim(),
				);
			}
		}

		// 3. Stack Overflow para preguntas técnicas
		if (category !== "general" && queries.length < 3) {
			const core = q
				.replace(/[?¿¡!]/g, "")
				.split(/\s+/)
				.slice(0, 8)
				.join(" ");
			queries.push(`site:stackoverflow.com ${core}`);
		}

		return [...new Set(queries)].slice(0, 3);
	}

	/**
	 * Multi-búsqueda: para cada query variante, busca con DDG Lite (Jina),
	 * extrae las URLs de los resultados, lee la primera URL con Jina Reader,
	 * y llama a `onProgress` en vivo tras cada fuente obtenida.
	 */
	async researchMultiple(
		query: string,
		onProgress?: (description: string) => Promise<void>,
	): Promise<ResearchResult | null> {
		const category = this.detectCategory(query);
		const queries = this.generateQueries(query);
		const seenUrls = new Set<string>();
		const sources: { url: string; content: string }[] = [];

		for (let i = 0; i < queries.length; i++) {
			const searchQuery = queries[i];
			await onProgress?.(
				`🔍 Buscando (${i + 1}/${queries.length}): \`${searchQuery}\`...`,
			);

			const searchResult = await this.searchDDGLite(searchQuery, 2);
			if (!searchResult) continue;

			// Leer la primera URL nueva encontrada
			const newUrl = searchResult.urls.find((u) => !seenUrls.has(u));
			if (!newUrl) continue;
			seenUrls.add(newUrl);

			const content = await this.fetchMarkdown(
				newUrl,
				this.MAX_CONTENT_CHARS_MULTI,
			);
			if (!content?.trim()) continue;

			sources.push({ url: newUrl, content });

			const remaining = queries.slice(i + 1);
			await onProgress?.(
				[
					`🔍 Fuente ${sources.length} obtenida.`,
					remaining.length > 0
						? remaining
								.map((q, j) => `*(${i + j + 2}/${queries.length}) \`${q}\`*`)
								.join("\n")
						: "",
				]
					.filter(Boolean)
					.join("\n"),
			);
		}

		if (sources.length === 0) return null;

		const contextForAI = [
			`[Contexto de internet — ${sources.length} fuente(s): ${sources.map((s) => s.url).join(", ")}]`,
			...sources.map(
				(s, i) => `--- Fuente ${i + 1}: ${s.url} ---\n${s.content}`,
			),
			"[Fin del contexto web]",
		].join("\n\n");

		return {
			category,
			contextForAI,
			sourceUrl: sources[0].url,
			sourceUrls: sources.map((s) => s.url),
		};
	}

	/**
	 * Búsqueda simple (sin progreso en vivo). Busca con DDG Lite y lee
	 * la primera URL relevante con Jina Reader.
	 */
	async research(query: string): Promise<ResearchResult | null> {
		const category = this.detectCategory(query);
		const prefix = SEARCH_PREFIXES[category];
		const searchQuery = prefix ? `${prefix} ${query}` : query;

		const searchResult = await this.searchDDGLite(searchQuery, 1);
		const url = searchResult?.urls[0];
		if (!url) return null;

		const content = await this.fetchMarkdown(url, this.MAX_CONTENT_CHARS);
		if (!content?.trim()) return null;

		const contextForAI = [
			`[Contexto obtenido de internet — fuente: ${url}]`,
			content,
			"[Fin del contexto web]",
		].join("\n\n");

		return { category, contextForAI, sourceUrl: url };
	}
}

export const webResearchService = new WebResearchService();
