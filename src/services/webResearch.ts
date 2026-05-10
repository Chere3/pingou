import { aiService } from "@/services/ai";

export interface ResearchResult {
	contextForAI: string;
	sourceUrl: string;
	sourceUrls?: string[];
}

class WebResearchService {
	private readonly JINA_BASE = "https://r.jina.ai/";
	private readonly FETCH_TIMEOUT_MS = 8_000;
	private readonly MAX_CONTENT_CHARS = 3_000;
	private readonly MAX_CONTENT_CHARS_MULTI = 1_500;

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
	 * Multi-búsqueda: el modelo genera 2-3 queries optimizadas para la pregunta,
	 * luego busca cada una con DDG Lite (Jina), extrae la primera URL nueva,
	 * la lee con Jina Reader y llama a `onProgress` en vivo tras cada fuente.
	 */
	async researchMultiple(
		query: string,
		onProgress?: (description: string) => Promise<void>,
	): Promise<ResearchResult | null> {
		await onProgress?.("🤔 Generando queries de búsqueda...");
		const queries = await aiService.generateSearchQueries(query);

		const seenUrls = new Set<string>();
		const sources: { url: string; content: string }[] = [];

		for (let i = 0; i < queries.length; i++) {
			const searchQuery = queries[i];
			if (!searchQuery) continue;
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

		const sourceUrls = sources.map((s) => s.url);
		return {
			contextForAI,
			sourceUrl: sourceUrls.at(0) ?? "",
			sourceUrls,
		};
	}

	/**
	 * Búsqueda simple (sin progreso en vivo). El modelo genera la primera
	 * query óptima y lee la primera URL relevante con Jina Reader.
	 */
	async research(query: string): Promise<ResearchResult | null> {
		const queries = await aiService.generateSearchQueries(query);
		const searchResult = await this.searchDDGLite(queries[0] ?? query, 1);
		const url = searchResult?.urls[0];
		if (!url) return null;

		const content = await this.fetchMarkdown(url, this.MAX_CONTENT_CHARS);
		if (!content?.trim()) return null;

		const contextForAI = [
			`[Contexto obtenido de internet — fuente: ${url}]`,
			content,
			"[Fin del contexto web]",
		].join("\n\n");

		return { contextForAI, sourceUrl: url };
	}
}

export const webResearchService = new WebResearchService();
