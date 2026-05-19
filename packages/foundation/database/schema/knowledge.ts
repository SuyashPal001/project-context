import { pgTable, uuid, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { customType } from 'drizzle-orm/pg-core';

const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector(768)';
  },
  fromDriver(value: string): number[] {
    return value.slice(1, -1).split(',').map(Number);
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
});

const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const knowledgeChunks = pgTable('knowledge_chunks', {
  id:             uuid('id').primaryKey().defaultRandom(),
  tenantId:       uuid('tenant_id').notNull(),

  // classification
  layer:          text('layer').notNull(),
  fileType:       text('file_type').notNull(),
  filePath:       text('file_path').notNull(),
  taskId:         uuid('task_id'),
  eventType:      text('event_type').notNull(),

  // content
  content:        text('content').notNull(),
  embedding:      vector('embedding'),
  tsv:            tsvector('tsv'),

  // chunk position
  chunkIndex:     integer('chunk_index').notNull().default(0),
  totalChunks:    integer('total_chunks').notNull().default(1),

  // lifecycle
  indexedAt:      timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  invalidatedAt:  timestamp('invalidated_at', { withTimezone: true }),
}, (t) => ({
  tenantIdx:    index('idx_knowledge_tenant').on(t.tenantId),
  filePathIdx:  index('idx_knowledge_file_path').on(t.filePath),
  taskIdx:      index('idx_knowledge_task_id').on(t.taskId),
  layerIdx:     index('idx_knowledge_layer').on(t.layer),
  eventTypeIdx: index('idx_knowledge_event_type').on(t.eventType),
}));
