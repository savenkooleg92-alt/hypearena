# HYPE ARENA - Prediction Market Platform

A full-stack web application for creating and participating in prediction markets.

## Features

- 🎯 Create and manage prediction markets
- 💰 Place bets on market outcomes
- 📊 Real-time market odds and pricing
- 👤 User authentication and profiles
- 💵 Virtual wallet system
- 📈 Market resolution and payout system
- 🎨 Modern, responsive UI

## Tech Stack

### Backend
- Node.js with Express
- TypeScript
- PostgreSQL with Prisma ORM
- JWT authentication
- bcrypt for password hashing

### Frontend
- Next.js 14 (App Router)
- React with TypeScript
- Tailwind CSS
- Shadcn/ui components

## Getting Started

### Prerequisites
- Node.js 18+ 
- PostgreSQL 14+
- npm or yarn

### Installation

1. Clone the repository
2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
# Backend
cp backend/.env.example backend/.env
# Edit backend/.env with your database credentials

# Frontend
cp frontend/.env.example frontend/.env
```

4. Set up the database:
```bash
cd backend
npm run prisma:generate
npm run db:deploy
```
Use `db:deploy` (runs `prisma migrate deploy`) to apply migrations without taking long-lived advisory locks. Use `prisma migrate dev` only when creating new migrations, and run it in a single terminal to avoid stuck locks on Neon.

5. Start the development servers:
```bash
npm run dev
```

The backend will run on `http://localhost:3001` and frontend on `http://localhost:3000`.

## Project Structure

```
hype-arena/
├── backend/          # Express API server
├── frontend/         # Next.js application
└── README.md
```

## License

MIT
