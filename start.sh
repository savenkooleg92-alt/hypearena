#!/bin/bash

echo "🚀 ЗАПУСК HYPE ARENA: ПОЛНЫЙ ЦИКЛ..."

# 1. Лечим Бэкенд
echo "🛠 Настройка бэкенда..."
cd backend
npm install
# Принудительно обновляем базу и клиент Prisma
npx prisma db push
npx prisma generate

# 2. Лечим Фронтенд
echo "🎨 Настройка фронтенда..."
cd ../frontend
npm install

# 3. Очистка и Запуск
echo "🔥 Запускаю серверы..."
cd ..

# Убиваем старые процессы, если они зависли
kill $(lsof -t -i:3000) 2>/dev/null
kill $(lsof -t -i:3001) 2>/dev/null

# Запуск обоих серверов (через concurrently или вручную)
if [ -f "package.json" ] && grep -q "concurrently" package.json; then
    npm run dev
else
    # Запуск в параллельных потоках
    (cd backend && npm run dev) & (cd frontend && npm run dev)
fi