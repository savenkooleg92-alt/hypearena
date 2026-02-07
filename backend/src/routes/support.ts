import path from 'path';
import fs from 'fs';
import express, { Response } from 'express';
import multer from 'multer';
import prisma from '../utils/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { sendSupportTicketNotification, SUPPORT_EMAIL } from '../services/email.service';

const router = express.Router();

const ALLOWED_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
const ALLOWED_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.pdf'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_FILES = 3;

const uploadsDir = path.join(process.cwd(), 'uploads', 'support');

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ALLOWED_EXT.includes(ext) && ALLOWED_MIMES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: .png, .jpg, .jpeg, .webp, .pdf'));
    }
  },
});

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100) || 'file';
}

/** POST /api/support/ticket - create ticket (auth required). Multipart: subject, description, up to 3 files (max 5MB each). */
router.post(
  '/ticket',
  authenticateToken,
  (req: express.Request, res: Response, next: express.NextFunction) => {
    upload.array('attachments', MAX_FILES)(req, res, (err: unknown) => {
      if (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[support] upload error:', msg);
        return res.status(400).json({ error: msg });
      }
      next();
    });
  },
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.userId!;
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { username: true, email: true },
      });
      if (!user) return res.status(401).json({ error: 'User not found' });

      const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
      const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
      if (!subject) return res.status(400).json({ error: 'Subject is required' });
      if (!description || description.length < 10) {
        return res.status(400).json({ error: 'Description is required (at least 10 characters)' });
      }

      const files = (req as unknown as { files?: Express.Multer.File[] }).files || [];
      if (files.length > MAX_FILES) {
        return res.status(400).json({ error: `Maximum ${MAX_FILES} files allowed` });
      }

      const ticket = await prisma.supportTicket.create({
        data: {
          userId,
          username: user.username,
          userEmail: user.email,
          subject,
          description,
          attachments: [],
          status: 'OPEN',
        },
      });

      const attachmentPaths: string[] = [];
      const ticketDir = path.join(uploadsDir, ticket.id);
      if (files.length > 0) {
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
        if (!fs.existsSync(ticketDir)) fs.mkdirSync(ticketDir, { recursive: true });
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          const ext = path.extname(f.originalname || '').toLowerCase() || '.bin';
          const base = sanitizeFileName(path.basename(f.originalname || 'file', ext));
          const filename = `${base}-${Date.now()}${i}${ext}`;
          const filePath = path.join(ticketDir, filename);
          fs.writeFileSync(filePath, f.buffer);
          const relativePath = `support/${ticket.id}/${filename}`;
          attachmentPaths.push(relativePath);
        }
        await prisma.supportTicket.update({
          where: { id: ticket.id },
          data: { attachments: attachmentPaths },
        });
      }

      const baseUrl = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
      const attachmentLinks = attachmentPaths.map((p) => `${baseUrl}/api/support/attachment/${ticket.id}/${path.basename(p)}`);

      console.log('[support] ticket created ticketId=', ticket.id, 'SUPPORT_EMAIL=', SUPPORT_EMAIL, 'calling sendSupportTicketNotification/sendMail');
      let emailFailed = false;
      try {
        await sendSupportTicketNotification({
          ticketId: ticket.id,
          userId,
          username: user.username,
          userEmail: user.email,
          subject,
          description,
          attachmentLinks,
          timestamp: ticket.createdAt.toISOString(),
        });
      } catch (err) {
        emailFailed = true;
        console.error('[support] notification email error:', err instanceof Error ? err.message : err);
      }

      const payload: { ok: boolean; ticketId: string; message: string; emailWarning?: string } = {
        ok: true,
        ticketId: ticket.id,
        message: 'Thank you for your patience. We will respond within 24 hours.',
      };
      if (emailFailed) payload.emailWarning = 'Ticket created but email notification failed';
      return res.status(200).json(payload);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[support] create ticket error:', msg);
      return res.status(500).json({ error: msg });
    }
  }
);

/** GET /api/support/my-tickets - list current user's tickets (auth required) */
router.get('/my-tickets', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const tickets = await prisma.supportTicket.findMany({
      where: { userId: req.userId! },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        subject: true,
        description: true,
        attachments: true,
        status: true,
        adminReply: true,
        repliedAt: true,
        createdAt: true,
      },
    });
    return res.json(tickets);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[support] my-tickets error:', msg);
    return res.status(500).json({ error: msg });
  }
});

/** GET /api/support/attachment/:ticketId/:filename - serve attachment (owner or admin only) */
router.get('/attachment/:ticketId/:filename', authenticateToken, async (req: AuthRequest, res: Response) => {
  try {
    const { ticketId, filename } = req.params;
    const ticket = await prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { userId: true, attachments: true },
    });
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    if (ticket.userId !== req.userId) {
      const user = await prisma.user.findUnique({
        where: { id: req.userId! },
        select: { isAdmin: true },
      });
      if (!user?.isAdmin) return res.status(403).json({ error: 'Forbidden' });
    }
    const safeName = path.basename(filename).replace(/\.\./g, '');
    const filePath = path.join(uploadsDir, ticketId, safeName);
    if (!ticket.attachments.some((a: string) => path.basename(a) === safeName)) {
      return res.status(404).json({ error: 'Not found' });
    }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    return res.sendFile(path.resolve(filePath));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[support] attachment error:', msg);
    return res.status(500).json({ error: msg });
  }
});

export default router;
