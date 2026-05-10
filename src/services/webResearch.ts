import { aiService } from "@/services/ai";

export interface ResearchResult {
	contextForAI: string;
	sourceUrl: string;
	sourceUrls?: string[];
}

class WebResearchService {
	private readonly JINA_BASE = "https://r.jina.ai/";
	private readonly FETCH_TIMEOUT_MS = 8_000;
	private readonly MAX_QUERIES = 5;
	// Cuánto markdown bruto traer por URL desde Jina Reader. El extractor
	// por chunks se encarga de filtrar después.
	private readonly FETCH_MAX_CHARS = 12_000;
	// Chunks pasados al extractor LLM por fuente.
	private readonly CHUNK_SIZE = 4_000;
	private readonly CHUNK_OVERLAP = 500;
	// Cap de chunks procesados por fuente para acotar latencia (paralelo).
	private readonly MAX_CHUNKS_PER_SOURCE = 3;
	// Para fuentes cortas no vale la pena el round trip del extractor.
	private readonly EXTRACTOR_MIN_CHARS = 2_000;

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
	 * Splitter char-based con overlap. No corta en límites de palabra (los
	 * chunks pueden empezar/terminar mid-token) — el extractor LLM tolera
	 * eso fácilmente. El overlap previene perder info que esté en el límite.
	 */
	private splitText(
		text: string,
		chunkSize: number,
		overlap: number,
	): string[] {
		if (text.length <= chunkSize) return [text];
		const chunks: string[] = [];
		const stride = chunkSize - overlap;
		for (let i = 0; i < text.length; i += stride) {
			chunks.push(text.slice(i, i + chunkSize));
			if (i + chunkSize >= text.length) break;
		}
		return chunks;
	}

	/**
	 * Extrae los hechos relevantes a `query` desde el markdown bruto de una
	 * fuente. Para fuentes cortas (<EXTRACTOR_MIN_CHARS) devuelve el
	 * contenido tal cual — no vale la pena el round trip del extractor.
	 * Para fuentes largas, splittea en chunks (4000/500 overlap), corre el
	 * extractor en paralelo sobre los primeros MAX_CHUNKS_PER_SOURCE chunks
	 * y concatena los bullets.
	 *
	 * Si el extractor devuelve vacío para todos los chunks, fallback al
	 * raw slice — preferimos contexto crudo sobre nada.
	 */
	private async extractFromSource(
		query: string,
		rawContent: string,
	): Promise<string> {
		if (rawContent.length < this.EXTRACTOR_MIN_CHARS) return rawContent;

		const chunks = this.splitText(
			rawContent,
			this.CHUNK_SIZE,
			this.CHUNK_OVERLAP,
		).slice(0, this.MAX_CHUNKS_PER_SOURCE);

		const extractions = await Promise.all(
			chunks.map((chunk) => aiService.extractRelevantFacts(query, chunk)),
		);

		const combined = extractions
			.map((e) => e.trim())
			.filter((e) => e.length > 0)
			.join("\n");

		return combined || rawContent.slice(0, 1_500);
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
			// dejamos que el picker del modelo elija la mejor por
			// relevancia + reputación de dominio.
			const searchResult = await this.searchDDGLite(searchQuery, 5);
			const candidates =
				searchResult?.urls.filter((u) => !seenUrls.has(u)) ?? [];
			const newUrl = await aiService.pickBestUrl(query, candidates);

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
