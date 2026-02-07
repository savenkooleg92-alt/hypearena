# Эндпоинт диагностики Oracle: проверка

## Маршрут

- **Метод и путь:** `POST /api/admin/oracle/diagnostic`
- **Файл:** `src/routes/admin.ts` (строка ~482)
- **Подключение:** `app.use('/api/admin', adminRoutes)` в `src/index.ts`
- **Защита:** `withAuth` = `[authenticateToken, requireAdmin]` — нужен JWT админа

## Проверка после перезапуска бэкенда

1. **Полный перезапуск backend** (обязательно после добавления роута):
   ```bash
   cd backend
   # Остановить текущий процесс (Ctrl+C), затем:
   npm run build   # если запускаете через npm run start
   npm run dev     # или npm run start
   ```

2. **Без токена** — ожидается **401** (роут найден, нет авторизации):
   ```bash
   curl -s -w "\nHTTP: %{http_code}\n" -X POST http://localhost:3001/api/admin/oracle/diagnostic -H "Content-Type: application/json"
   ```

3. **С токеном админа** — ожидается **200** и JSON с диагностикой:
   ```bash
   curl -s -X POST http://localhost:3001/api/admin/oracle/diagnostic \
     -H "Authorization: Bearer YOUR_ADMIN_JWT" \
     -H "Content-Type: application/json"
   ```

Если видите **404** — процесс запущен со старой сборкой или без перезапуска после добавления роута.

## Next.js и прокси

В `frontend/next.config.js` **нет** rewrites для `/api/*`. Фронт должен слать запросы на бэкенд по его URL (например `NEXT_PUBLIC_API_URL` или `http://localhost:3001`), а не на относительный путь `/api/...` того же origin.

## Экспорт

Роут объявлен inline в `admin.ts`, роутер экспортируется как `export default router` и подключается в `index.ts` как `adminRoutes`.
