# Current state

Transport architecture подтверждена реальными тестами: HTTP remote import, Yandex continuous streaming/resume и bounded torrent source работают без полного staging.

Production-контур реализован: Fastify API/SSE, signed single-user session, SQLite WAL jobs/events/files, direct URL remote import, magnet/`.torrent` bounded transport, Yandex HEAD resume и адаптивный русскоязычный React/Vite PWA.

Локально подготовлен и проверен hotfix текущего production-инцидента, но он ещё не опубликован. Исправлены deadlock bounded cache при отсутствии нужной текущей piece, невидимый hash progress, бесконечное ожидание данных и пустые JSON pause/cancel запросы. Production по-прежнему работает на `efcd8b0`.

# Last completed step

Release `efcd8b0` опубликован на `https://loader.lumastack.ru`. Пользовательский арт подключён как PWA/Apple Touch icon, а iOS file picker больше не фильтрует `.torrent` через ненадёжное MIME/UTType-сопоставление; расширение и bencode проверяются после выбора. Public health, manifest, четыре PNG-размера и production bundle проверены. PM2 пересоздан с script path/cwd текущего release. `npm run typecheck`, `npm run build` и 8 tests проходят; предоставленный пользователем `.torrent` локально успешно разобран без вывода tracker/passkey.

# Current blocker

Deployment-блокера и torrent live-E2E риска нет. GitHub code release, VPS, PM2, nginx и TLS синхронизированы; текущий release `efcd8b0`, rollback `65fa83f`. Временное sudo-правило, upload-артефакты, failed/cancelled synthetic jobs и локальный seeder удалены.

Для direct remote import остаётся crash-window между получением operation URL от Яндекс и её сохранением в SQLite. Нужен реальный restart test незавершённой operation и idempotent recovery policy. Активную remote-import operation подтверждённым Disk API сейчас нельзя безопасно pause/cancel; UI это не имитирует.

Для hotfix требуется явное разрешение пользователя на commit/push/deploy. Текущая пользовательская torrent-задача остаётся `verifying`, а следующая direct URL задача — `queued`; до deployment не изменять их вручную.

# Next action

После разрешения: commit/push, собрать новый release, переключить `/home/deploy/loader/current`, restart только PM2 `loader`, затем подтвердить progress текущей задачи и реальные pause/cancel через production API/UI. После этого отдельно согласовать read-only SFTP bridge `Yandex Disk /Media -> rclone serve sftp -> VLC`; медиабайты в этой схеме проходят через VPS, но не staging-ятся на диске.

Затем закрыть crash-window direct remote import до записи operation URL и определить backup/retention для SQLite/shared runtime. Удалить `/Media/Movies/loader-e2e-restart.mp4` только после явного разрешения пользователя.

# Relevant files

- `poc/torrent-bounded.mjs`
- `poc/bounded-piece-store.mjs`
- `poc/seeder-child.mjs`
- `poc/yandex-upload.mjs`
- `src/server/app.ts`
- `src/server/database.ts`
- `src/server/job-runner.ts`
- `src/server/torrent-transfer.ts`
- `src/server/bounded-piece-store.ts`
- `src/server/security.ts`
- `src/server/yandex-disk.ts`
- `src/web/App.tsx`
- `src/web/components/JobsPanel.tsx`
- `src/web/components/SourceComposer.tsx`
- `src/web/styles.css`
- `index.html`
- `public/manifest.webmanifest`
- `public/icons/`
- `docs/design/loader-russian-concept.png`
- `scripts/store-yandex-token.mjs`
- `docs/PROJECT_CONTEXT.md`
- `docs/PLAN.md`
- `docs/PROGRESS.md`
- `docs/DECISIONS.md`
