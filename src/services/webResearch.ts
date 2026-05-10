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
	private readonly MAX_CONTENT_CHARS = 1_500;

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
		if (initialQueries.length === 0) return null;
		const seenUrls = new Set<string>();
		const sources: { url: string; content: string }[] = [];
		let queriesRun = 0;
		const pending = [...initialQueries];

		// Loop adaptativo: corre queries, evalúa resultados, repite si hace falta
		while (pending.length > 0 && queriesRun < this.MAX_QUERIES) {
			const searchQuery = pending.shift();
			if (!searchQuery) break;
			queriesRun++;

			await onProgress?.(`🔍 Búsqueda ${queriesRun}: \`${searchQuery}\`...`);

			const searchResult = await this.searchDDGLite(searchQuery, 2);
			const newUrl = searchResult?.urls.find((u) => !seenUrls.has(u));

			if (newUrl) {
				seenUrls.add(newUrl);
				const content = await this.fetchMarkdown(
					newUrl,
					this.MAX_CONTENT_CHARS,
				);
				if (content?.trim()) {
					sources.push({ url: newUrl, content });
					await onProgress?.(`✅ Fuente ${sources.length} obtenida.`);
				}
			}

			// Al agotar la cola, el modelo evalúa si los resultados son suficientes
			if (pending.length === 0 && queriesRun < this.MAX_QUERIES) {
				if (sources.length > 0) {
					await onProgress?.("🧠 Evaluando si se necesita más información...");
					const more = await aiService.evaluateSearchProgress(
						query,
						sources,
						this.MAX_QUERIES - queriesRun,
					);
					pending.push(...more);
				}
			}
		}

		if (sources.length === 0) return null;

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
