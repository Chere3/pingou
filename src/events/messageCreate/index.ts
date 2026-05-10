import { createEvent } from "seyfert";
import { CONFIG } from "@/config";
import { bumpService } from "@/services/bumpService";
import { handleAiMention } from "./aiMention";
import { handleAutoThread } from "./autoThread";
import { handleMemes } from "./memes";
import { handleThanks } from "./thanks";

export default createEvent({
	data: { once: false, name: "messageCreate" },
	async run(message, client) {
		// Disboard tiene flag bot:true; lo procesamos antes de filtrar bots
		if (message.author.id === CONFIG.OTHER.DISBOARD_ID) {
			await bumpService.handleBump(message);
			return;
		}

		if (message.author.bot) return;

		// Aditivo — corre y deja seguir la cadena
		await handleMemes(message, client);

		// Mutuamente excluyentes — el primero que aplique corta la cadena
		if (await handleAutoThread(message, client)) return;
		if (await handleAiMention(message, client)) return;
		await handleThanks(message, client);
	},
});
