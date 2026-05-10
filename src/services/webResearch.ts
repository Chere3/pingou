import { aiService } from "@/services/ai";

export interface ResearchResult {
	contextForAI: string;
	sourceUrl: string;
	sourceUrls?: string[];
}

class WebResearchService {
	private readonly JINA_BASE = "https://r.jina.ai/";
	private readonly FETCH_TIMEOUT_MS = 8_000;
	// Cap total de queries en el loop adaptativo. Cada query = 1 fetch + 1 LLM
	// call (extractor). El chat final agrega 1 call más.
	private readonly MAX_QUERIES = 4;
	// Cuánto markdown bruto traer por URL desde Jina Reader. El extractor
	// recibe esto entero en una sola call para no explotar requests.
	private readonly FETCH_MAX_CHARS = 8_000;
	// Para fuentes cortas no vale la pena el round trip del extractor.
	private readonly EXTRACTOR_MIN_CHARS = 1_500;

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
	 * DDG Lite codifica las URLs destino como `uddg=URL_ENCODED` en los
	 * hrefs de los resultados — los parseamos y decodificamos directamente.
	 */
	private async searchDDGLite(
		query: string,
		maxUrls = 3,
	): Promise<{ urls: string[] } | null> {
		const ddgUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
		const response = await this.fetchWithTimeout(`${this.JINA_BASE}${ddgUrl}`, {
			headers: { Accept: "text/plain" },
		});
		if (!response?.ok) return null;

		try {
			const text = await response.text();
			if (!text.trim()) return null;

			const urls = [...text.matchAll(/uddg=([^&\s")\]]+)/g)]
				.map((m) => {
					const raw = m[1];
					if (!raw) return null;
					try {
						return decodeURIComponent(raw);
					} catch {
						return null;
					}
				})
				.filter(
					(u): u is string =>
						!!u && u.startsWith("http") && !u.includes("duckduckgo.com"),
				)
				.slice(0, maxUrls);

			return { urls };
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
	 * Ranking heurístico de URLs por reputación de dominio + señales de
	 * spam/junk. Reemplaza al LLM picker para ahorrar llamadas al modelo
	 * (rate limit del provider). Los dominios y patrones son inferidos del
	 * uso real de la comunidad de programación.
	 */
	private rankUrlsByReputation(urls: string[]): string[] {
		const score = (url: string): number => {
			const u = url.toLowerCase();
			let s = 0;
			// Docs oficiales — máxima prioridad
			if (/\bdocs?\.(?:[\w-]+\.)+\w+\//.test(u)) s += 12;
			if (/developer\.mozilla\.org|mdn\b/.test(u)) s += 10;
			// Source canónicas
			if (/github\.com\/[^/]+\/[^/]+/.test(u)) s += 8;
			if (/stackoverflow\.com\/questions/.test(u)) s += 7;
			if (/wikipedia\.org\/wiki/.test(u)) s += 6;
			// Sitios oficiales (.io, .dev, .org, github.io de proyectos)
			if (/github\.io/.test(u)) s += 5;
			if (/\b(?:\w+\.)+(?:io|dev)\b/.test(u)) s += 3;
			// Blogs técnicos conocidos
			if (/dev\.to|medium\.com|hashnode\.com/.test(u)) s += 2;
			// Penalizaciones
			if (/pinterest|tiktok|facebook|instagram/.test(u)) s -= 8;
			if (/[?&](utm_|fbclid|gclid|ref=)/.test(u)) s -= 2;
			if (/\/(?:tag|tags|category|categories)\//.test(u)) s -= 3;
			return s;
		};
		return [...urls].sort((a, b) => score(b) - score(a));
	}

	/**
	 * Extrae los hechos relevantes a `query` con UNA sola call al modelo
	 * sobre el contenido entero (truncado a FETCH_MAX_CHARS). Reemplaza al
	 * chunked extractor anterior (que hacía 3 calls paralelas por fuente)
	 * para ahorrar requests. qwen3-coder-480b tiene context window enorme,
	 * 8k chars cabe holgadamente.
	 *
	 * Fuentes cortas (<EXTRACTOR_MIN_CHARS) salteán el extractor y se
	 * devuelven crudas.
	 */
	private async extractFromSource(
		query: string,
		rawContent: string,
	): Promise<string> {
		if (rawContent.length < this.EXTRACTOR_MIN_CHARS) return rawContent;
		return await aiService.extractRelevantFacts(query, rawContent);
	}

	/**
	 * Loop adaptativo de investigación web. Recibe las queries iniciales
	 * (ya generadas por el modelo, típicamente vía aiService.generateSearchQueries)
	 * y evalúa tras cada ronda si necesita buscar más (0-N adicionales).
	 * Se detiene cuando el modelo está satisfecho o se alcanzan MAX_QUERIES (5).
	 *
	 * El call site es quien decide si investigar (consultando al modelo) y reclama
	 * recursos como rate-limit antes de llamar acá. Esto evita que decisiones del
	 * modelo de "no investigar" gasten slots de rate limit u otros recursos.
	 */
	async researchMultiple(
		query: string,
		initialQueries: string[],
		onProgress?: (description: string) => Promise<void>,
	): Promise<ResearchResult | null> {
		if (!initialQueries.length) return null;
		const seenUrls = new Set<string>();
		const sources: { url: string; content: string }[] = [];
		const executedQueries: string[] = [];
		let queriesRun = 0;
		const pending = [...initialQueries];

		// Loop adaptativo: corre queries, evalúa resultados, repite si hace falta
		while (pending.length && queriesRun < this.MAX_QUERIES) {
			const searchQuery = pending.shift();
			if (!searchQuery) break;
			queriesRun++;
			executedQueries.push(searchQuery);

			await onProgress?.(`🔍 Búsqueda ${queriesRun}: \`${searchQuery}\`...`);

			// Pedimos hasta 5 URLs del SERP, filtramos las ya extraídas
			// (cross-round dedup estilo Perplexica alreadyExtractedURLs) y
			// rankeamos por heurística de dominio (en lugar de un LLM call
			// adicional, que sumaba demasiados requests).
			const searchResult = await this.searchDDGLite(searchQuery, 5);
			const candidates = this.rankUrlsByReputation(
				searchResult?.urls.filter((u) => !seenUrls.has(u)) ?? [],
			);
			const newUrl = candidates[0] ?? null;

			if (newUrl) {
				seenUrls.add(newUrl);
				const rawContent = await this.fetchMarkdown(
					newUrl,
					this.FETCH_MAX_CHARS,
				);
				if (rawContent?.trim()) {
					await onProgress?.(
						`📝 Extrayendo info relevante de fuente ${sources.length + 1}...`,
					);
					const content = await this.extractFromSource(query, rawContent);
					if (content.trim()) {
						sources.push({ url: newUrl, content });
						await onProgress?.(`✅ Fuente ${sources.length} obtenida.`);
					}
				}
			}

			// Al agotar la cola, el modelo evalúa si los resultados son suficientes
			if (!pending.length && queriesRun < this.MAX_QUERIES && sources.length) {
				await onProgress?.("🧠 Evaluando si se necesita más información...");
				const more = await aiService.evaluateSearchProgress(
					query,
					sources,
					this.MAX_QUERIES - queriesRun,
					executedQueries,
				);
				pending.push(...more);
			}
		}

		if (!sources.length) return null;

		const sourceUrls = sources.map((s) => s.url);
		const contextForAI = [
			`[Contexto de internet — ${sources.length} fuente(s): ${sourceUrls.join(", ")}]`,
			...sources.map(
				(s, i) => `--- Fuente ${i + 1}: ${s.url} ---\n${s.content}`,
			),
			"[Fin del contexto web]",
		].join("\n\n");

		return {
			contextForAI,
			sourceUrl: sourceUrls.at(0) ?? "",
			sourceUrls,
		};
	}
}

export const webResearchService = new WebResearchService();
