import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';

export const reviewZip = pgTable('review_zip', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  zipFileId: text('zip_file_id').notNull(),
  folderStructure: jsonb("folder_structure").notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
