import { config } from "seyfert";
import { env } from "@/config";

export default config.bot({
	token: env?.BOT_TOKEN,
	locations: {
		base: "src",
		commands: "commands",
		events: "events",
		components: "components",
	},
	intents: [
		"Guilds",
		"GuildModeration",
		"GuildExpressions",
		"GuildIntegrations",
		"GuildWebhooks",
		"GuildInvites",
		"GuildVoiceStates",
		"GuildMessages",
		"GuildMessageReactions",
		"GuildMessageTyping",
		"DirectMessages",
		"DirectMessageReactions",
		"DirectMessageTyping",
		"GuildScheduledEvents",
		"AutoModerationConfiguration",
		"AutoModerationExecution",
		"GuildMessagePolls",
		"DirectMessagePolls",
	],
	publicKey: env.PUBLIC_KEY,
	port: env.PORT,
});
