import { ActionRow, Button, createEvent, Embed } from "seyfert";
import { type APIEmbed, ButtonStyle } from "seyfert/lib/types";
import { CONFIG } from "@/config";
import { pendingRepRepository } from "@/repositories/pendingRepRepository";
import { aiService } from "@/services/ai";
import { bumpService } from "@/services/bumpService";
import { cooldownService } from "@/services/cooldown";
import { webResearchService } from "@/services/webResearch";
import { Embeds } from "@/utils/embeds";

function normalizeText(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function containsThanks(text: string): boolean {
	const normalized = normalizeText(text);
	return CONFIG.OTHER.THANKS_TERMS.some((term) =>
		new RegExp(`\\b${term}\\b`).test(normalized),
	);
}

export default createEvent({
	data: { once: false, name: "messageCreate" },
	async run(message, client) {
		// Ignorar bots y Disboard primero para no procesar innecesariamente
		if (message.author.id === CONFIG.OTHER.DISBOARD_ID) {
			await bumpService.handleBump(message);
			return;
		}

		if (message.author.bot) return;

		// Meme reactions — después del bot check para no reaccionar a bots
		if (
			CONFIG.CHANNELS.MEMES &&
			message.channelId === CONFIG.CHANNELS.MEMES &&
			CONFIG.MEMES_REACTIONS.length
		) {
			await Promise.all(
				CONFIG.MEMES_REACTIONS.map((emoji) =>
					client.reactions
						.add(message.id, message.channelId, emoji)
						.catch(() => {}),
				),
			);
		}

		// Auto-thread en canales configurados
		const autoChannels = CONFIG.AUTO_THREAD_CHANNELS.filter(Boolean);
		if (autoChannels.includes(message.channelId)) {
			try {
				const raw = message.content?.trim() || message.author.username;
				const threadName = raw.slice(0, 100);
				const thread = await client.messages.thread(
					message.channelId,
					message.id,
					{ name: threadName, auto_archive_duration: 1440 },
				);
				await client.messages.write(thread.id, {
					content: `<@${message.author.id}>`,
				});
			} catch {}
			return;
		}

		// AI mention reply
		if (message.mentions.users.some((u) => u.id === client.me.id)) {
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
				return message.reply({
					embeds: [
						Embeds.errorEmbed(
							"Calma!",
							`Estás saturando la IA. Espera **${remaining} segundos** por favor.`,
						),
					],
				});
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
			const shouldResearch = cleanContent.length >= 4;

			if (cleanContent.length > 0) {
				promptMessages = [`${message.author.username}: ${cleanContent}`];
			} else {
				const prevMessages = await aiService.getLatestMessages(
					client,
					message.channelId,
					contextLimit + 1,
					message.author.id,
				);
				if (!prevMessages.length) return;
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
				const initialQueries =
					await aiService.generateSearchQueries(cleanContent);

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

			const [firstEmbed, ...restEmbeds] = embeds;
			if (statusMsg && firstEmbed) {
				await client.messages
					.edit(statusMsg.id, statusMsg.channelId, {
						embeds: [firstEmbed as APIEmbed],
					})
					.catch((err) =>
						console.error("Error editing AI reply status embed:", err),
					);
				for (const embed of restEmbeds) {
					await message
						.reply({ embeds: [embed] })
						.catch((err) =>
							console.error("Error sending AI reply chunk:", err),
						);
				}
			} else {
				// Mención sin texto — o el statusMsg falló al crearse — replicamos todo
				for (const embed of embeds) {
					await message
						.reply({ embeds: [embed] })
						.catch((err) => console.error("Error sending AI reply:", err));
				}
			}
			return;
		}

		// Thanks detection
		if (!CONFIG.CHANNELS.REP_NOTIFICATION) return;

		const content = message.content ?? "";
		if (!containsThanks(content)) return;

		const giverId = message.author.id;
		const guildId = message.guildId;
		if (!guildId) return;

		// Solo escuchar canales permitidos
		try {
			const channel = (await client.channels.fetch(message.channelId)) as {
				id: string;
				parentId?: string;
			} | null;
			if (!channel) return;

			const allowed =
				channel.id === CONFIG.CHANNELS.CHAT_PROGRAMADORES ||
				channel.parentId === CONFIG.CATEGORIES.FORUMS ||
				(channel.parentId
					? await client.channels
							.fetch(channel.parentId)
							.then(
								(p) =>
									(p as { parentId?: string } | null)?.parentId ===
									CONFIG.CATEGORIES.FORUMS,
							)
							.catch(() => false)
					: false);

			if (!allowed) return;
		} catch {
			return;
		}

		// 1. Explicit @mentions
		const mentionsArray = Array.isArray(message.mentions.users)
			? message.mentions.users
			: [
					...(
						message.mentions.users as Map<
							string,
							{ id: string; username: string; bot?: boolean }
						>
					).values(),
				];
		const explicitMentions = mentionsArray
			.filter((u: { id: string; bot?: boolean }) => !u.bot && u.id !== giverId)
			.slice(0, 4);

		// 2. Reply target
		const replyAuthor = message.referencedMessage?.author;
		const replyReceiver =
			replyAuthor && !replyAuthor.bot && replyAuthor.id !== giverId
				? replyAuthor
				: null;

		let receiverUsers: Array<{ id: string; username: string }> = [];

		if (explicitMentions.length > 0) {
			receiverUsers = explicitMentions;
		} else if (replyReceiver) {
			receiverUsers = [replyReceiver];
		} else {
			// Busca en los últimos 30 mensajes usuarios que le respondieron al giver
			try {
				const recentMsgs = await client.messages.list(message.channelId, {
					limit: 30,
				});
				const seen = new Set<string>();
				for (const msg of recentMsgs) {
					if (msg.id === message.id) continue;
					if (msg.author.bot || msg.author.id === giverId) continue;
					if (msg.referencedMessage?.author?.id !== giverId) continue;
					if (seen.has(msg.author.id)) continue;
					seen.add(msg.author.id);
					receiverUsers.push(msg.author);
					if (receiverUsers.length >= 4) break;
				}
			} catch {
				return;
			}
		}

		if (receiverUsers.length === 0) return;

		const messageUrl = `https://discord.com/channels/${guildId}/${message.channelId}/${message.id}`;
		const referencedContent = message.referencedMessage?.content ?? null;

		const receivers = receiverUsers.map(
			(u: { id: string; username: string }) => ({
				id: u.id,
				name: u.username,
			}),
		);

		const notifEmbed = Embeds.repNotificationEmbed({
			giverId,
			giverName: message.author.username,
			receivers,
			messageUrl,
			channelId: message.channelId,
			thanksContent: content,
			referencedContent,
		});

		const approveButtons = receivers.map((_r, i) =>
			new Button()
				.setCustomId(`rep-approve-${i}`)
				.setLabel(`${i + 1}`)
				.setStyle(ButtonStyle.Primary),
		);

		const eliminarButton = new Button()
			.setCustomId("rep-reject-all")
			.setLabel("Eliminar")
			.setStyle(ButtonStyle.Secondary);

		const row = new ActionRow<Button>().setComponents([
			...approveButtons,
			eliminarButton,
		]);

		const notifMsg = await client.messages.write(
			CONFIG.CHANNELS.REP_NOTIFICATION,
			{ embeds: [notifEmbed], components: [row] },
		);

		await Promise.all(
			receivers.map((r, i) =>
				pendingRepRepository.create({
					id: `${notifMsg.id}-${i}`,
					giverId,
					receiverId: r.id,
					originalMessageId: message.id,
					originalChannelId: message.channelId,
				}),
			),
		);
	},
});
