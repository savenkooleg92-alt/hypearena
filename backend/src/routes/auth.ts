import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../utils/prisma';

const router = express.Router();

router.post('/register', async (req, res) => {
  try {
    const { email, username, password } = req.body;

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email,
        username,
        password: hashedPassword,
        isAdmin: false,
      },
    });

    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET || 'super-secret-key'
    );

    res.status(201).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        balance: user.balance,
        isAdmin: user.isAdmin ?? false,
        isAnonymous: user.isAnonymous ?? false,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown';
    console.error('ПОЛНАЯ ОШИБКА РЕГИСТРАЦИИ:', error);
    res.status(500).json({ error: 'Ошибка на сервере: ' + message });
  }
});

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key';

router.post('/login', async (req, res) => {
  try {
    const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!rawEmail || !password) {
      return res.status(400).json({ error: 'Email и пароль обязательны' });
    }

    const user = await prisma.user.findFirst({
      where: { email: { equals: rawEmail, mode: 'insensitive' } },
    });

    if (!user) {
      return res.status(401).json({ error: 'Неверные данные' });
    }

    if (!user.password) {
      return res.status(401).json({ error: 'Неверные данные' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Неверные данные' });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        balance: user.balance,
        isAdmin: user.isAdmin ?? false,
        isAnonymous: user.isAnonymous ?? false,
      },
    });
  } catch (error) {
    console.error('[auth] login error:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Ошибка входа' });
  }
});

export default router;
