import { PrismaClient } from '@prisma/client';

// Neon (and pooled Postgres): reduce timeouts and connection usage to avoid P1002 / advisory lock
const raw = process.env.DATABASE_URL ?? '';
const hasLimit = raw.includes('connection_limit');
const hasConnectTimeout = raw.includes('connect_timeout');
const hasPoolTimeout = raw.includes('pool_timeout');
const params: string[] = [];
if (!hasLimit) params.push('connection_limit=5');
if (!hasConnectTimeout) params.push('connect_timeout=30');
if (!hasPoolTimeout) params.push('pool_timeout=30');
const suffix =
  raw && params.length > 0 ? (raw.includes('?') ? '&' : '?') + params.join('&') : '';
const url = suffix ? raw + suffix : raw;

const prisma = new PrismaClient(
  url ? { datasources: { db: { url } } } : undefined
);

export default prisma;
