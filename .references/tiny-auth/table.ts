import { index, uniqueIndex } from 'drizzle-orm/pg-core'
import { securitySchema, genID } from './base.schema'

export const apiKeys = securitySchema.table(
	'apiKeys',
	(t) => ({
		id: t
			.text()
			.primaryKey()
			.$defaultFn(() => genID('API_KEY')),
		tokenHash: t.text('token_hash').notNull(),
		tokenPrefix: t.text('token_prefix').notNull(),
		namespace: t.text().notNull(),
		name: t.text().notNull(),
		metadata: t.jsonb().notNull(),
		expiresAt: t.timestamp('expires_at').notNull(),
		maxIdleMs: t.numeric('max_idle_ms', { mode: 'number' }).notNull(),
		lastUsedAt: t.timestamp('last_used_at').notNull(),
		revoked: t.boolean('revoked').notNull().default(false),
		replacedBy: t.text('replaced_by'),
		createdAt: t
			.timestamp('created_at')
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: t
			.timestamp('updated_at')
			.notNull()
			.$defaultFn(() => new Date()),
	}),
	(t) => [
		uniqueIndex('api_key_token_hash_idx').on(t.tokenHash),
		index('api_key_token_prefix_idx').on(t.tokenPrefix),
		index('api_key_namespace_idx').on(t.namespace),
		index('api_key_namespace_revoked_idx').on(t.namespace, t.revoked),
		index('api_key_name_idx').on(t.name),
		index('api_key_expires_at_idx').on(t.expiresAt),
		index('api_key_max_idle_ms_idx').on(t.maxIdleMs),
		index('api_key_last_used_at_idx').on(t.lastUsedAt),
	],
)

export const encryptedKeys = securitySchema.table(
	'encryptedKeys',
	(t) => ({
		id: t
			.text()
			.primaryKey()
			.$defaultFn(() => genID('EK')),
		namespace: t.text().notNull(),
		keyName: t.text('key_name').notNull(),
		encryptedValue: t.text('encrypted_value').notNull(),
		iv: t.text().notNull(),
		createdAt: t
			.timestamp('created_at')
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: t
			.timestamp('updated_at')
			.notNull()
			.$defaultFn(() => new Date()),
	}),
	(t) => [
		uniqueIndex('encrypted_key_namespace_key_name_idx').on(
			t.namespace,
			t.keyName,
		),
		index('encrypted_key_namespace_idx').on(t.namespace),
		index('encrypted_key_key_name_idx').on(t.keyName),
	],
)

export const config = securitySchema.table(
	'config',
	(t) => ({
		id: t
			.text()
			.primaryKey()
			.$defaultFn(() => genID('CFG')),
		key: t.text().notNull(),
		value: t.jsonb().notNull(),
		createdAt: t
			.timestamp('created_at')
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: t
			.timestamp('updated_at')
			.notNull()
			.$defaultFn(() => new Date()),
	}),
	(t) => [index('config_key_idx').on(t.key)],
)