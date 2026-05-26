import { db, schema } from '@server/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

/** Used when `expiresAt` is omitted (no practical expiry). */
const NEVER_EXPIRES_AT = new Date('2100-01-01T00:00:00.000Z')

export const createTokenSchema = z.object({
	namespace: z.string().describe('Namespace; JSON.stringify non-string keys before sending.'),
	name: z.string().optional().describe('Name of the token'),
	metadata: z.unknown().optional().describe('Metadata of the token'),
	expiresAt: z.number().optional().describe('Expiration date of the token'),
	maxIdleMs: z.number().optional().describe('Max idle time of the token, used to revoke the token if it is not used for a certain period of time'),
})

export const invalidateAllTokenSchema = z.object({
	namespace: z.unknown().optional(),
	before: z.number().optional(),
	after: z.number().optional(),
})

/** Namespace as stored in DB: plain string, or JSON-encoded for structured keys (GET-friendly). */
const authNamespaceSchema = z
	.string()
	.describe('Namespace; JSON.stringify non-string keys before sending')

export const listTokenSchema = z.object({
	namespace: authNamespaceSchema,
	includeRevoked: z.coerce.boolean().optional(),
})

export const invalidateByIdSchema = z.object({
	tokenId: z.string(),
})

export const cleanupSchema = z.object({
	olderThanMs: z.number().optional(),
})

export const storeValueSchema = z.object({
	namespace: z.unknown(),
	keyName: z.string(),
	value: z.string(),
	encryptionKey: z.string(),
})

export const getValueSchema = z.object({
	namespace: z.unknown(),
	keyName: z.string(),
	encryptionKey: z.string(),
})

export const storeEncryptedKeySchema = z.object({
	namespace: z.unknown(),
	keyName: z.string(),
	encryptedValue: z.string(),
	iv: z.string(),
})

export const getEncryptedKeySchema = z.object({
	namespace: authNamespaceSchema,
	keyName: z.string(),
})

export const deleteEncryptedKeySchema = z.object({
	namespace: authNamespaceSchema,
	keyName: z.string(),
})

export const listEncryptedKeysSchema = z.object({
	namespace: authNamespaceSchema,
})

export const authService = {
  	createToken: async (args: z.infer<typeof createTokenSchema>) => {
		const token = generateToken()
		const tokenHash = await hashToken(token)
		const tokenPrefix = getTokenPrefix(token)
		const now = new Date()
		const expiresAt =
			args.expiresAt != null ? new Date(args.expiresAt) : NEVER_EXPIRES_AT

		const [row] = await db
			.insert(schema.apiKeys)
			.values({
				tokenHash,
				tokenPrefix,
				namespace: normalizeNamespace(args.namespace),
				name: args.name ?? '',
				metadata: (args.metadata ??
					{}) as typeof schema.apiKeys.$inferInsert.metadata,
				expiresAt,
				maxIdleMs: args.maxIdleMs ?? 0,
				lastUsedAt: now,
				revoked: false,
			})
			.returning({ id: schema.apiKeys.id })

		if (!row) throw new Error('Failed to create API key')

		return { token, tokenPrefix, tokenId: row.id }
	},

	validate: async (token: string): Promise<ValidateTokenResult> => {
		const tokenHash = await hashToken(token)
		const record = await db.query.apiKeys.findFirst({
			where: { tokenHash },
		})

		if (!record) {
			return { ok: false, reason: 'invalid' }
		}

		if (record.revoked) {
			return {
				ok: false,
				reason: 'revoked',
				namespace: record.namespace,
			}
		}

		const nowMs = Date.now()

		if (nowMs > record.expiresAt.getTime()) {
			return {
				ok: false,
				reason: 'expired',
				namespace: record.namespace,
			}
		}

		if (
			record.maxIdleMs &&
			nowMs - record.lastUsedAt.getTime() > record.maxIdleMs
		) {
			return {
				ok: false,
				reason: 'idle_timeout',
				namespace: record.namespace,
			}
		}

		const touchAt = new Date()
		await db
			.update(schema.apiKeys)
			.set({ lastUsedAt: touchAt, updatedAt: touchAt })
			.where(eq(schema.apiKeys.id, record.id))

		return {
			ok: true,
			namespace: record.namespace,
			metadata: record.metadata,
			tokenId: record.id,
		}
	},

	touch: async (token: string): Promise<boolean> => {
		const tokenHash = await hashToken(token)
		const record = await db.query.apiKeys.findFirst({
			where: { tokenHash },
		})

		if (!record || record.revoked) return false

		const touchAt = new Date()
		await db
			.update(schema.apiKeys)
			.set({ lastUsedAt: touchAt, updatedAt: touchAt })
			.where(eq(schema.apiKeys.id, record.id))
		return true
	},

	refresh: async (token: string): Promise<RefreshTokenResult> => {
		const tokenHash = await hashToken(token)
		const record = await db.query.apiKeys.findFirst({
			where: { tokenHash },
		})

		if (!record) {
			return { ok: false, reason: 'invalid' }
		}

		if (record.revoked) {
			return { ok: false, reason: 'revoked' }
		}

		const now = new Date()
		const newToken = generateToken()
		const newTokenHash = await hashToken(newToken)
		const newTokenPrefix = getTokenPrefix(newToken)

		const [inserted] = await db
			.insert(schema.apiKeys)
			.values({
				tokenHash: newTokenHash,
				tokenPrefix: newTokenPrefix,
				namespace: record.namespace,
				name: record.name,
				metadata: record.metadata,
				expiresAt: record.expiresAt,
				maxIdleMs: record.maxIdleMs,
				lastUsedAt: now,
				revoked: false,
			})
			.returning({ id: schema.apiKeys.id })

		if (!inserted) throw new Error('Failed to refresh API key')

		const touchAt = new Date()
		await db
			.update(schema.apiKeys)
			.set({
				revoked: true,
				replacedBy: inserted.id,
				updatedAt: touchAt,
			})
			.where(eq(schema.apiKeys.id, record.id))

		return {
			ok: true,
			token: newToken,
			tokenPrefix: newTokenPrefix,
			tokenId: inserted.id,
		}
	},

	invalidate: async (token: string): Promise<boolean> => {
		const tokenHash = await hashToken(token)
		const record = await db.query.apiKeys.findFirst({
			where: { tokenHash },
		})

		if (!record) return false

		const touchAt = new Date()
		await db
			.update(schema.apiKeys)
			.set({ revoked: true, updatedAt: touchAt })
			.where(eq(schema.apiKeys.id, record.id))
		return true
	},

	invalidateById: async (tokenId: string): Promise<boolean> => {
		const record = await db.query.apiKeys.findFirst({
			where: { id: tokenId },
		})
		if (!record) return false

		const touchAt = new Date()
		await db
			.update(schema.apiKeys)
			.set({ revoked: true, updatedAt: touchAt })
			.where(eq(schema.apiKeys.id, tokenId))
		return true
	},

	invalidateAll: async (
		args: z.infer<typeof invalidateAllTokenSchema>,
	): Promise<number> => {
		const ns =
			args.namespace !== undefined
				? normalizeNamespace(args.namespace)
				: undefined

		let rows: (typeof schema.apiKeys.$inferSelect)[]
		if (ns !== undefined) {
			rows = await db.query.apiKeys.findMany({
				where: {
					AND: [{ namespace: ns }, { revoked: false }],
				},
			})
		} else {
			rows = await db.query.apiKeys.findMany({
				where: {
					revoked: false,
				},
			})
		}

		let count = 0
		const touchAt = new Date()

		for (const token of rows) {
			if (token.revoked) continue
			if (args.before !== undefined && token.createdAt.getTime() >= args.before)
				continue
			if (args.after !== undefined && token.createdAt.getTime() <= args.after)
				continue

			await db
				.update(schema.apiKeys)
				.set({ revoked: true, updatedAt: touchAt })
				.where(eq(schema.apiKeys.id, token.id))
			count++
		}

		return count
	},

	list: async (args: z.infer<typeof listTokenSchema>) => {
		const ns = normalizeNamespace(args.namespace)
		const rows = await db.query.apiKeys.findMany({
			where: {
				namespace: ns,
				revoked: args.includeRevoked === true ? undefined : false,
			},
		})
		return rows
	},

	cleanup: async (olderThanMs?: number): Promise<number> => {
		const threshold = olderThanMs ?? 30 * 24 * 60 * 60 * 1000
		const cutoffMs = Date.now() - threshold

		const all = await db.query.apiKeys.findMany()
		let deleted = 0

		for (const token of all) {
			const shouldDelete =
				(token.revoked && token.createdAt.getTime() < cutoffMs) ||
				token.expiresAt.getTime() < cutoffMs

			if (shouldDelete) {
				await db.delete(schema.apiKeys).where(eq(schema.apiKeys.id, token.id))
				deleted++
			}
		}

		return deleted
	},

	storeValue: async (args: z.infer<typeof storeValueSchema>) => {
		const { encryptedValue, iv } = await encryptInternal(
			args.value,
			args.encryptionKey,
		)
		const now = new Date()
		const ns = normalizeNamespace(args.namespace)

		const existing = await db.query.encryptedKeys.findFirst({
			where: {
				namespace: ns,
				keyName: args.keyName,
			},
		})

		if (existing) {
			await db
				.update(schema.encryptedKeys)
				.set({
					encryptedValue,
					iv,
					updatedAt: now,
				})
				.where(eq(schema.encryptedKeys.id, existing.id))
		} else {
			await db.insert(schema.encryptedKeys).values({
				namespace: ns,
				keyName: args.keyName,
				encryptedValue,
				iv,
				createdAt: now,
				updatedAt: now,
			})
		}

		return null
	},

	getValue: async (args: z.infer<typeof getValueSchema>) => {
		const ns = normalizeNamespace(args.namespace)
		const record = await db.query.encryptedKeys.findFirst({
			where: {
				namespace: ns,
				keyName: args.keyName,
			},
		})

		if (!record) return null

		return await decryptInternal(
			record.encryptedValue,
			record.iv,
			args.encryptionKey,
		)
	},

	storeEncryptedKey: async (args: z.infer<typeof storeEncryptedKeySchema>) => {
		const now = new Date()
		const ns = normalizeNamespace(args.namespace)

		const existing = await db.query.encryptedKeys.findFirst({
			where: {
				namespace: ns,
				keyName: args.keyName,
			},
		})

		if (existing) {
			await db
				.update(schema.encryptedKeys)
				.set({
					encryptedValue: args.encryptedValue,
					iv: args.iv,
					updatedAt: now,
				})
				.where(eq(schema.encryptedKeys.id, existing.id))
		} else {
			await db.insert(schema.encryptedKeys).values({
				namespace: ns,
				keyName: args.keyName,
				encryptedValue: args.encryptedValue,
				iv: args.iv,
				createdAt: now,
				updatedAt: now,
			})
		}

		return null
	},

	getEncryptedKey: async (
		args: z.infer<typeof getEncryptedKeySchema>,
	): Promise<{
		encryptedValue: string
		iv: string
		createdAt: number
		updatedAt: number
	} | null> => {
		const ns = normalizeNamespace(args.namespace)
		const record = await db.query.encryptedKeys.findFirst({
			where: {
				namespace: ns,
				keyName: args.keyName,
			},
		})

		if (!record) return null

		return {
			encryptedValue: record.encryptedValue,
			iv: record.iv,
			createdAt: record.createdAt.getTime(),
			updatedAt: record.updatedAt.getTime(),
		}
	},

	deleteEncryptedKey: async (
		args: z.infer<typeof deleteEncryptedKeySchema>,
	): Promise<boolean> => {
		const ns = normalizeNamespace(args.namespace)
		const record = await db.query.encryptedKeys.findFirst({
			where: {
				namespace: ns,
				keyName: args.keyName,
			},
		})

		if (!record) return false

		await db
			.delete(schema.encryptedKeys)
			.where(eq(schema.encryptedKeys.id, record.id))
		return true
	},

	listEncryptedKeys: async (
		args: z.infer<typeof listEncryptedKeysSchema>,
	): Promise<
		Array<{ keyName: string; createdAt: number; updatedAt: number }>
	> => {
		const ns = normalizeNamespace(args.namespace)
		const records = await db.query.encryptedKeys.findMany({
			where: {
				namespace: ns,
			},
		})

		return records.map((r) => ({
			keyName: r.keyName,
			createdAt: r.createdAt.getTime(),
			updatedAt: r.updatedAt.getTime(),
		}))
	},
}

export type ValidateTokenResult =
	| {
			ok: true
			namespace: string
			metadata: unknown
			tokenId: string
	  }
	| {
			ok: false
			reason: 'expired' | 'idle_timeout' | 'revoked' | 'invalid'
			namespace?: string
	  }

export type RefreshTokenResult =
	| {
			ok: true
			token: string
			tokenPrefix: string
			tokenId: string
	  }
	| { ok: false; reason: string }

function normalizeNamespace(value: unknown): string {
	if (typeof value === 'string') return value
	return JSON.stringify(value)
}

function generateToken(): string {
	const bytes = new Uint8Array(24)
	crypto.getRandomValues(bytes)
	const hex = Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
	return `sk_${hex}`
}

async function hashToken(token: string): Promise<string> {
	const encoder = new TextEncoder()
	const data = encoder.encode(token)
	const hashBuffer = await crypto.subtle.digest('SHA-256', data)
	const hashArray = Array.from(new Uint8Array(hashBuffer))
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

function getTokenPrefix(token: string): string {
	if (token.length <= 12) return token
	return `${token.slice(0, 7)}...${token.slice(-4)}`
}

async function deriveKey(secret: string, usage: 'encrypt' | 'decrypt') {
	const encoder = new TextEncoder()
	const keyMaterial = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'PBKDF2' },
		false,
		['deriveKey'],
	)
	return await crypto.subtle.deriveKey(
		{
			name: 'PBKDF2',
			salt: encoder.encode('convex-api-tokens-salt'),
			iterations: 100_000,
			hash: 'SHA-256',
		},
		keyMaterial,
		{ name: 'AES-GCM', length: 256 },
		false,
		[usage],
	)
}

async function encryptInternal(
	plaintext: string,
	secret: string,
): Promise<{ encryptedValue: string; iv: string }> {
	const encoder = new TextEncoder()
	const key = await deriveKey(secret, 'encrypt')
	const iv = crypto.getRandomValues(new Uint8Array(12))
	const encrypted = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		key,
		encoder.encode(plaintext),
	)
	return {
		encryptedValue: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
		iv: btoa(String.fromCharCode(...iv)),
	}
}

async function decryptInternal(
	encryptedValue: string,
	iv: string,
	secret: string,
): Promise<string> {
	const key = await deriveKey(secret, 'decrypt')
	const ivBytes = Uint8Array.from(atob(iv), (c) => c.charCodeAt(0))
	const data = Uint8Array.from(atob(encryptedValue), (c) => c.charCodeAt(0))
	const decrypted = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: ivBytes },
		key,
		data,
	)
	return new TextDecoder().decode(decrypted)
}