import express from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../utils/prisma';
import { authenticateToken, AuthRequest } from '../middleware/auth';

const router = express.Router();

/** In-memory pending email change: userId -> { newEmail, code, expiresAt }. In production use Redis or DB. */
const emailChangePending = new Map<
  string,
  { newEmail: string; code: string; expiresAt: number }
>();
const OTP_EXPIRY_MS = 15 * 60 * 1000; // 15 min

function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

router.get('/me', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: {
        id: true,
        email: true,
        username: true,
        balance: true,
        isAdmin: true,
        isAnonymous: true,
        createdAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

const updateProfileSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string().min(8).optional(),
  isAnonymous: z.boolean().optional(),
}).refine(
  (data) => {
    if (data.newPassword && !data.currentPassword) return false;
    return true;
  },
  { message: 'Current password required to set new password', path: ['currentPassword'] }
);

router.patch('/me', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const parse = updateProfileSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: 'Invalid input', details: parse.error.flatten() });
    }
    const { currentPassword, newPassword, isAnonymous } = parse.data;

    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { id: true, password: true },
    });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const updates: { password?: string; isAnonymous?: boolean } = {};

    if (newPassword != null && currentPassword != null) {
      const valid = await bcrypt.compare(currentPassword, user.password);
      if (!valid) {
        return res.status(400).json({ error: 'Current password is incorrect' });
      }
      updates.password = await bcrypt.hash(newPassword, 10);
    }

    if (isAnonymous !== undefined) {
      updates.isAnonymous = isAnonymous;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: updates,
    });

    const updated = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        email: true,
        username: true,
        balance: true,
        isAdmin: true,
        isAnonymous: true,
        createdAt: true,
      },
    });
    return res.json(updated);
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

const emailRequestSchema = z.object({ newEmail: z.string().email() });
router.post('/me/email/request', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const parse = emailRequestSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: 'Invalid email' });
    }
    const { newEmail } = parse.data;
    const userId = req.userId!;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const existing = await prisma.user.findUnique({
      where: { email: newEmail.toLowerCase().trim() },
      select: { id: true },
    });
    if (existing) {
      return res.status(400).json({ error: 'Email already in use' });
    }
    const code = generateOtp();
    emailChangePending.set(userId, {
      newEmail: newEmail.toLowerCase().trim(),
      code,
      expiresAt: Date.now() + OTP_EXPIRY_MS,
    });
    // TODO: send OTP to user.email (current email) via mailer. For now log.
    console.log(`[email-change] OTP for ${user.email} → ${newEmail}: ${code}`);
    return res.json({ ok: true, message: 'Verification code sent to your current email' });
  } catch (error) {
    console.error('Email request error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

const emailConfirmSchema = z.object({
  newEmail: z.string().email(),
  code: z.string().length(6),
});
router.post('/me/email/confirm', authenticateToken, async (req: AuthRequest, res) => {
  try {
    const parse = emailConfirmSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: 'Invalid input' });
    }
    const { newEmail, code } = parse.data;
    const userId = req.userId!;
    const pending = emailChangePending.get(userId);
    if (!pending) {
      return res.status(400).json({ error: 'No pending email change. Request a new code.' });
    }
    if (Date.now() > pending.expiresAt) {
      emailChangePending.delete(userId);
      return res.status(400).json({ error: 'Code expired. Request a new code.' });
    }
    if (pending.newEmail !== newEmail.toLowerCase().trim() || pending.code !== code) {
      return res.status(400).json({ error: 'Invalid code or email' });
    }
    emailChangePending.delete(userId);
    await prisma.user.update({
      where: { id: userId },
      data: { email: pending.newEmail },
    });
    const updated = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, username: true, balance: true, isAdmin: true, isAnonymous: true, createdAt: true },
    });
    return res.json(updated);
  } catch (error) {
    console.error('Email confirm error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;