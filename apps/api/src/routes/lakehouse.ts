import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { AppEnv } from '../types';

const lakehouseRoutes = new Hono<AppEnv>();

const LAKEHOUSE_URL = process.env.LAKEHOUSE_URL ?? 'http://localhost:8001';

// GET /lakehouse/snapshots — list all Delta versions with labels
lakehouseRoutes.get('/snapshots', async (c) => {
  try {
    const res = await fetch(`${LAKEHOUSE_URL}/snapshots`);
    if (!res.ok) return c.json({ snapshots: [] }, 200);
    const data = await res.json();
    return c.json(data);
  } catch {
    return c.json({ snapshots: [] }, 200);
  }
});

// GET /lakehouse/records?version=0 — read records at a specific version
lakehouseRoutes.get('/records', async (c) => {
  const version = c.req.query('version');
  const url = version !== undefined
    ? `${LAKEHOUSE_URL}/records?version=${version}`
    : `${LAKEHOUSE_URL}/records`;
  try {
    const res = await fetch(url);
    if (!res.ok) return c.json({ records: [], version: 0 }, 200);
    const data = await res.json();
    return c.json(data);
  } catch {
    return c.json({ records: [], version: 0 }, 200);
  }
});

// POST /lakehouse/commit — write a full snapshot (called from ingestion)
lakehouseRoutes.post(
  '/commit',
  zValidator('json', z.object({
    records: z.array(z.object({
      pension_id: z.string(),
      pensioner_name: z.string(),
      declared_amount: z.number(),
      status: z.string(),
      office_code: z.string().default('PB-001'),
      effective_date: z.string(),
    })),
    label: z.string(),
    description: z.string().optional(),
  })),
  async (c) => {
    const body = c.req.valid('json');
    try {
      const res = await fetch(`${LAKEHOUSE_URL}/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      return c.json(data);
    } catch {
      return c.json({ error: 'Lakehouse service unavailable' }, 503);
    }
  }
);

// POST /lakehouse/correct — single-record correction, creates new version
lakehouseRoutes.post(
  '/correct',
  zValidator('json', z.object({
    pension_id: z.string(),
    new_amount: z.number().positive(),
    label: z.string().min(1),
    description: z.string().optional(),
  })),
  async (c) => {
    const body = c.req.valid('json');
    try {
      const res = await fetch(`${LAKEHOUSE_URL}/correct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null) as { detail?: string } | null;
        return c.json({ error: err?.detail ?? 'Correction failed' }, res.status as any);
      }
      const data = await res.json();
      return c.json(data);
    } catch {
      return c.json({ error: 'Lakehouse service unavailable' }, 503);
    }
  }
);

export { lakehouseRoutes };
