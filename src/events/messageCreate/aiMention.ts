import { randomUUID } from "node:crypto";
import {
	ActionRow,
	Button,
	Embed,
	type Message,
	type UsingClient,
} from "seyfert";
import { type APIEmbed, ButtonStyle } from "seyfert/lib/types";
import { CONFIG } from "@/config";
import { aiService } from "@/services/ai";
import { aiSourcesStore } from "@/services/aiSources";
import { cooldownService } from "@/services/cooldown";
import { webResearchService } from "@/services/webResearch";
import { Embeds } from "@/utils/embeds";

/**
 * Construye un ActionRow con el botón "📚 Ver fuentes (N)" cuando hay 2+
 * fuentes. Guarda las URLs en el store en memoria con TTL y embebe el key
 * en el customId. Con 1 sola fuente devuelve undefined porque el footer
 * del embed ya muestra la URL directa.
 */
function buildSourcesRow(
	sourceUrls: string[] | undefined,
): ActionRow<Button> | undefined {
	if (!sourceUrls || sourceUrls.length < 2) return undefined;
	const key = randomUUID().slice(0, 8);
	aiSourcesStore.save(key, sourceUrls);
	return new ActionRow<Button>().setComponents([
		new Button()
			.setCustomId(`ai-sources:${key}`)
			.setLabel(`📚 Ver fuentes (${sourceUrls.length})`)
			.setStyle(ButtonStyle.Secondary),
	]);
}

/**
 * Maneja menciones al bot (@Pingou ...) con respuesta de IA, investigación
 * web adaptativa y rate limit. Devuelve true si el mensaje mencionaba al
 * bot (incluso si rebotó por cooldown), para cortar la cadena.
 */
export async function handleAiMention(
	message: Message,
	client: UsingClient,
): Promise<boolean> {
	if (!message.mentions.users.some((u) => u.id === client.me.id)) return false;

	const userId = message.author.id;
	const cooldownKey = "ai-mention";

	const currentCooldown = await cooldownService.getCooldown(
		userId,
		cooldownKey,
	);
	if (currentCooldown) {
		const remaining = Math.ceil(
			(currentCooldown.expiresAt.getTime() - Date.now()) / 1000,
		);
		await message
			.reply({
				embeds: [
					Embeds.errorEmbed(
						"Calma!",
						`Estás saturando la IA. Espera **${remaining} segundos** por favor.`,
					),
				],
			})
			.catch((err) => console.error("Error sending cooldown notice:", err));
		return true;
	}

	// Extraemos el contenido limpio quitando el mention al bot
	const cleanContent = (message.content ?? "")
		.replaceAll(new RegExp(`<@!?${client.me.id}>`, "g"), "")
		.trim();

	let contextLimit = 2;
	const match = /contexto:\s*(\d+)/i.exec(cleanContent);
	if (match?.[1]) {
		contextLimit = Math.min(Number.parseInt(match[1], 10), 10);
	}

	// Mostramos "Procesando..." inmediatamente para preguntas con contenido,
	// así el usuario sabe que el bot está trabajando mientras clasifica.
	const statusMsg =
		cleanContent.length > 0
			? await message.reply({
					embeds: [
						new Embed().setDescription("💭 Procesando...").setColor("Blue"),
					],
				})
			: null;

	// Preparamos el prompt. Si hay contenido directo lo usamos; si la mención
	// vino sin texto, buscamos los últimos mensajes del usuario como contexto.
	let promptMessages: string[];
	// El modelo dentro de researchMultiple decide por sí mismo si investigar
	// (0 queries = no investiga) y cuántas búsquedas hacer. Solo verificamos
	// que haya contenido mínimo para no llamar al modelo en menciones vacías.
	// El feature flag CONFIG.AI.RESEARCH_ENABLED permite desactivar todo el
	// módulo de investigación web sin tocar el código.
	const shouldResearch = CONFIG.AI.RESEARCH_ENABLED && cleanContent.length >= 4;

	if (cleanContent.length > 0) {
		promptMessages = [`${message.author.username}: ${cleanContent}`];
	} else {
		const prevMessages = await aiService.getLatestMessages(
			client,
			message.channelId,
			contextLimit + 1,
			message.author.id,
		);
		if (!prevMessages.length) return true;
		promptMessages = [...prevMessages]
			.reverse()
			.map((m) => `${m.author.username}: ${m.content ?? ""}`);
	}

	// Callback que edita el embed en vivo con el progreso de la investigación
	const onProgress = statusMsg
		? async (description: string) => {
				await client.messages
					.edit(statusMsg.id, statusMsg.channelId, {
						embeds: [
							new Embed().setDescription(description).setColor("Yellow"),
						],
					})
					.catch(() => {});
			}
		: undefined;

	let webResult: Awaited<
		ReturnType<typeof webResearchService.researchMultiple>
	> = null;
	if (shouldResearch) {
		// Primero el modelo decide si vale la pena investigar (gratis: no
		// cuesta slot ni red). Solo si devuelve queries reales reclamamos
		// un slot del rate limit y arrancamos el loop de búsqueda.
		const initialQueries = await aiService.generateSearchQueries(cleanContent);

		if (initialQueries.length) {
			const slot = await cooldownService
				.claimRateLimitSlot(userId, "ai-research", 2, 60)
				.catch((err) => {
					console.error("Error claiming research slot:", err);
					return { ok: true } as const;
				});
			if (slot.ok) {
				webResult = await webResearchService.researchMultiple(
					cleanContent,
					initialQueries,
					onProgress,
				);
			} else {
				await onProgress?.(
					`⏳ Límite de investigación alcanzado (2/min). Respondiendo sin contexto web — espera **${slot.retryAfter}s** para volver a buscar.`,
				);
			}
		}
	}

	// aiService.chat ya devuelve texto fallback ante cualquier fallo de IA,
	// así que no necesitamos wrap defensivo aquí.
	const { text, usage } = await aiService.chat(
		promptMessages,
		webResult?.contextForAI,
	);

	await cooldownService
		.setCooldown(userId, cooldownKey, 15)
		.catch((err) => console.error("Error setting AI cooldown:", err));

	const embeds = Embeds.aiReplyEmbeds(
		text,
		usage,
		webResult?.sourceUrl,
		webResult?.sourceUrls,
	);

	// Botón "📚 Ver fuentes" cuando hay 2+ fuentes (con 1 sola el footer ya
	// la muestra directo). Va en el ÚLTIMO chunk para que el usuario lo
	// encuentre al terminar de leer la respuesta.
	const sourcesRow = buildSourcesRow(webResult?.sourceUrls);
	const components = sourcesRow ? [sourcesRow] : undefined;

	const [firstEmbed, ...restEmbeds] = embeds;
	if (statusMsg && firstEmbed) {
		// Para respuestas single-chunk, el "último embed" es el primero (el
		// editado del statusMsg). Solo en ese caso le adjuntamos los components
		// al edit. Si hay restEmbeds, el row va en el último reply.
		const firstIsLast = !restEmbeds.length;
		await client.messages
			.edit(statusMsg.id, statusMsg.channelId, {
				embeds: [firstEmbed as APIEmbed],
				...(firstIsLast && components ? { components } : {}),
			})
			.catch((err) =>
				console.error("Error editing AI reply status embed:", err),
			);
		for (const [i, embed] of restEmbeds.entries()) {
			const isLast = i === restEmbeds.length - 1;
			await message
				.reply({
					embeds: [embed],
					...(isLast && components ? { components } : {}),
				})
				.catch((err) => console.error("Error sending AI reply chunk:", err));
		}
	} else {
		// Mención sin texto — o el statusMsg falló al crearse — replicamos todo
		for (const [i, embed] of embeds.entries()) {
			const isLast = i === embeds.length - 1;
			await message
				.reply({
					embeds: [embed],
					...(isLast && components ? { components } : {}),
				})
				.catch((err) => console.error("Error sending AI reply:", err));
		}
	}

	return true;
}
