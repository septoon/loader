# Лоадер

Персональный PWA-сервис для передачи медиафайлов на Яндекс Диск.

- Прямые HTTP(S) ссылки передаются официальным remote import Яндекс Диска без проксирования медиабайтов через VPS.
- Magnet и `.torrent` читаются последовательно через ограниченный piece-cache и отправляются continuous PUT.
- После обрыва Яндекс Диск сообщает authoritative offset через `HEAD`; задача продолжается без полного staging.
- Очередь, события, per-file hashes и checkpoints хранятся в SQLite WAL.

## Локальный запуск

Требуется Node.js 22+.

```bash
npm ci
npm run build
npm test
npm start
```

Для разработки без `LOADER_PASSWORD` используется пароль `loader-local`. Токен Яндекс Диска хранится только в `runtime/secrets/yandex-token` с правами `0600`:

```bash
npm run yandex:store-token
```

Production-переменные перечислены в `.env.example`. Полный медиофайл на VPS не сохраняется; размер piece-cache и резерв свободного диска обязательны к контролю.

Production password/session secret создаются без вывода значений и остаются в ignored-каталоге:

```bash
npm run production:create-secrets
```

Подробности архитектуры и актуальный статус находятся в `docs/PROJECT_CONTEXT.md`, `docs/DECISIONS.md`, `docs/PROGRESS.md` и `docs/HANDOFF.md`.
