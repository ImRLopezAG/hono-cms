import { createId } from '@paralleldrive/cuid2'
import { pgSchema } from 'drizzle-orm/pg-core'

export const securitySchema = pgSchema('security')

export const genID = (prefix: string) => `${prefix}-${createId()}`
