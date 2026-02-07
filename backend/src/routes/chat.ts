import express, { Response } from 'express';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';

const router = express.Router();

const MAX_BODY_LENGTH = 500;
const MIN_BODY_LENGTH = 1;
const RATE_LIMIT_MS = 2000; // 1 message per 2 seconds per user

const lastMessageByUser = new Map<string, number>();

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const last = lastMessageByUser.get(userId);
  if (last != null && now - last < RATE_LIMIT_MS) return false;
  lastMessageByUser.set(userId, now);
  return true;
}

/** Get or create thread for eventKey. Returns { threadId }. Auth optional for GET. */
router.get('/thread/:eventKey', async (req, res: Response) => {
  try {
    const eventKey = req.params.eventKey;
    if (!eventKey || eventKey.length > 200) {
      return res.status(400).json({ error: 'Invalid eventKey' });
    }
    const thread = await prisma.chatThread.upsert({
      where: { eventKey },
      create: { eventKey },
      update: {},
    });
    return res.json({ threadId: thread.id });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: 'Failed to get thread', message });
  }
});

/** Get messages for thread. Paginate by cursor (message id) and limit. Newest first. */
router.get('/thread/:eventKey/messages', async (req, res: Response) => {
  try {
    const eventKey = req.params.eventKey;
    if (!eventKey) return res.status(400).json({ error: 'eventKey required' });
    const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 100);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;

    const thread = await prisma.chatThread.findUnique({
      where: { eventKey },
    });
    if (!thread) {
      return res.json({ messages: [], nextCursor: null });
    }

    const orderBy = { createdAt: 'desc' as const };
    const take = limit + 1;
    const messages = cursor
      ? await prisma.chatMessage.findMany({
          where: { threadId: thread.id },
          orderBy,
          take,
          cursor: { id: cursor },
          select: {
            id: true,
            userId: true,
            username: true,
            body: true,
            createdAt: true,
          },
        })
      : await prisma.chatMessage.findMany({
          where: { threadId: thread.id },
          orderBy,
          take,
          select: {
            id: true,
            userId: true,
            username: true,
            body: true,
            createdAt: true,
          },
        });

    const hasMore = messages.length > limit;
    const list = hasMore ? messages.slice(0, limit) : messages;
    const nextCursor = hasMore && list.length > 0 ? list[list.length - 1].id : null;

    return res.json({
      messages: list.map((m: { id: string; userId: string | null; username: string | null; body: string; createdAt: Date }) => ({
        id: m.id,
        userId: m.userId,
        username: m.username ?? 'Anonymous',
        body: m.body,
        createdAt: m.createdAt.toISOString(),
      })),
      nextCursor,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: 'Failed to get messages', message });
  }
});

const postMessageSchema = z.object({
  body: z
    .string()
    .min(MIN_BODY_LENGTH, 'Message too short')
    .max(MAX_BODY_LENGTH, 'Message too long')
    .transform((s) => s.trim())
    .refine((s) => s.length >= MIN_BODY_LENGTH, 'Message too short'),
  anonymous: z.boolean().optional(),
});

/** Post a message. Auth required. Rate limit 1 per 2s per user. */
router.post('/thread/:eventKey/messages', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const eventKey = req.params.eventKey;
    if (!eventKey || eventKey.length > 200) {
      return res.status(400).json({ error: 'Invalid eventKey' });
    }

    const parse = postMessageSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: 'Invalid body', details: parse.error.flatten() });
    }
    const { body, anonymous: sendAsAnonymous } = parse.data;

    if (!checkRateLimit(userId)) {
      return res.status(429).json({ error: 'Rate limit: wait 2 seconds before sending again' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { username: true, isAnonymous: true },
    });

    const showAsAnonymous = sendAsAnonymous === true || user?.isAnonymous === true;
    const finalUserId = showAsAnonymous ? null : userId;
    const finalUsername = showAsAnonymous ? 'Anonymous' : (user?.username ?? 'Unknown');

    const thread = await prisma.chatThread.upsert({
      where: { eventKey },
      create: { eventKey },
      update: {},
    });

    const message = await prisma.chatMessage.create({
      data: {
        threadId: thread.id,
        userId: finalUserId,
        username: finalUsername,
        body,
      },
      select: {
        id: true,
        userId: true,
        username: true,
        body: true,
        createdAt: true,
      },
    });

    return res.status(201).json({
      message: {
        id: message.id,
        userId: message.userId,
        username: message.username ?? 'Anonymous',
        body: message.body,
        createdAt: message.createdAt.toISOString(),
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: 'Failed to send message', message });
  }
});

export default router;
