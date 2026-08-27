# Лоадер

Персональный PWA-сервис для передачи медиафайлов на Яндекс Диск.

- Прямые HTTP(S) ссылки передаются официальным remote import Яндекс Диска без проксирования медиабайтов через VPS.
- Magnet и `.torrent` читаются последовательно через ограниченный piece-cache и отправляются continuous PUT.
- Страницы Rutube разрешаются через официальный play-options API и сохраняются последовательным HLS-потоком без staging.
- После обрыва Яндекс Диск сообщает authoritative offset через `HEAD`; задача продолжается без полного staging.
- Очередь, события, per-file hashes и checkpoints хранятся в SQLite WAL.
- Папка `/Media` доступна VLC через отдельный read-only SFTP-процесс; чтение идёт диапазонами из Яндекс Диска без локального медиакеша.

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
Тайм-аут одного Yandex PUT по умолчанию — 360 минут; после неоднозначного обрыва worker всё равно получает server-authoritative offset и продолжает тот же файл.

Production password/session secret создаются без вывода значений и остаются в ignored-каталоге:

```bash
npm run production:create-secrets
npm run production:create-vlc-secrets
```

`loader-vlc` запускается вторым приложением из `ecosystem.config.cjs`. По умолчанию он слушает TCP `2022`, показывает содержимое `/Media` как корень SFTP, допускает не более 8 подключений и запрещает все операции записи. Учётные данные и постоянный SSH host key остаются только в ignored `runtime/secrets/`.

Подробности архитектуры и актуальный статус находятся в `docs/PROJECT_CONTEXT.md`, `docs/DECISIONS.md`, `docs/PROGRESS.md` и `docs/HANDOFF.md`.
