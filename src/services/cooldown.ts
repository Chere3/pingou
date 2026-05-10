import { cooldownRepository } from "@/repositories/cooldownRepository";

export class CooldownService {
	async setCooldown(userId: string, key: string, seconds: number) {
		const expiresAt = new Date(Date.now() + seconds * 1000);
		const id = `${userId}:${key}`;
		await cooldownRepository.upsert(id, userId, key, expiresAt);
	}

	async getCooldown(userId: string, key: string) {
		const id = `${userId}:${key}`;
		const cooldown = await cooldownRepository.findById(id);

		if (!cooldown || cooldown.expiresAt < new Date()) {
			await this.deleteCooldown(userId, key);
			return null;
		}

		return cooldown;
	}

	async deleteCooldown(userId: string, key: string) {
		const id = `${userId}:${key}`;
		await cooldownRepository.deleteById(id);
	}

	async cleanup() {
		await cooldownRepository.deleteExpired(new Date());
	}

	/**
	 * Rate limit estilo "N usos por ventana de Y segundos" usando slots
	 * derivados de la key (`<key>:0`, `<key>:1`, ...). Cada slot ocupado
	 * vive `windowSeconds`; cuando se liberan se reciclan automáticamente.
	 *
	 * Devuelve `{ ok: true }` si pudo reservar un slot, o
	 * `{ ok: false, retryAfter }` con los segundos hasta que se libere
	 * el slot más próximo.
	 */
	async claimRateLimitSlot(
		userId: string,
		key: string,
		maxSlots: number,
		windowSeconds: number,
	): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
		let earliestExpiry = Number.POSITIVE_INFINITY;
		for (let i = 0; i < maxSlots; i++) {
			const slotKey = `${key}:${i}`;
			const existing = await this.getCooldown(userId, slotKey);
			if (!existing) {
				await this.setCooldown(userId, slotKey, windowSeconds);
				return { ok: true };
			}
			earliestExpiry = Math.min(earliestExpiry, existing.expiresAt.getTime());
		}
		const retryAfter = Math.ceil((earliestExpiry - Date.now()) / 1000);
		return { ok: false, retryAfter: Math.max(retryAfter, 1) };
	}
}

export const cooldownService = new CooldownService();
