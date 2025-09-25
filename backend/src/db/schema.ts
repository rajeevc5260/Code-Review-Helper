import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';

export const reviewZip = pgTable('review_zip', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  zipFileId: text('zip_file_id').notNull(),
  folderStructure: jsonb("folder_structure").notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const chatConversations = pgTable('chat_conversations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  zipFileId: text('zip_file_id').notNull(),
  title: text('title').default('New chat'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const chatMessages = pgTable('chat_messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  userId: text('user_id').notNull(),
  role: text('role').notNull(),       // 'user' | 'assistant' | 'system' (text keeps it simple)
  content: text('content').notNull(), // markdown/plaintext
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// conversations for the Document Analyser app
export const docChatConversations = pgTable('doc_chat_conversations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  docFileId: text('doc_file_id').notNull(),
  title: text('title').default('New chat'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// messages for the Document Analyser app
export const docChatMessages = pgTable('doc_chat_messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  userId: text('user_id').notNull(),
  role: text('role').notNull(),       // 'user' | 'assistant' | 'system'
  content: text('content').notNull(), // markdown/plaintext
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});