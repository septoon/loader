# Current state

Transport architecture подтверждена реальными тестами: HTTP remote import, Yandex continuous streaming/resume и bounded torrent source работают без полного staging.

Production-контур реализован: Fastify API/SSE, signed single-user session, SQLite WAL jobs/events/files, direct URL remote import, magnet/`.torrent` bounded transport, Yandex HEAD resume и адаптивный русскоязычный React/Vite PWA.

# Last completed step

Release `65fa83f` опубликован на `https://loader.lumastack.ru`. Public health/auth/jobs/SSE/static smoke прошёл. Синтетический 16 MiB production magnet E2E завершился после контролируемых PM2 restart с тем же job/upload checkpoint; Yandex metadata и HTTP Range для VLC подтверждены. TLS действует до `2026-11-25` с автоматическим обновлением. `npm run typecheck`, `npm run build`, 8 tests и 256 MiB bounded torrent PoC проходят; browser QA выполнен на desktop/mobile.

# Current blocker

Deployment-блокера и torrent live-E2E риска нет. GitHub, VPS release, PM2, nginx и TLS синхронизированы. Временное sudo-правило, upload-артефакты, failed/cancelled synthetic jobs и локальный seeder удалены.

Для direct remote import остаётся crash-window между получением operation URL от Яндекс и её сохранением в SQLite. Нужен реальный restart test незавершённой operation и idempotent recovery policy. Активную remote-import operation подтверждённым Disk API сейчас нельзя безопасно pause/cancel; UI это не имитирует.

# Next action

Закрыть crash-window direct remote import до записи operation URL и определить backup/retention для SQLite/shared runtime. Удалить `/Media/Movies/loader-e2e-restart.mp4` только после явного разрешения пользователя.

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
- `docs/design/loader-russian-concept.png`
- `scripts/store-yandex-token.mjs`
- `docs/PROJECT_CONTEXT.md`
- `docs/PLAN.md`
- `docs/PROGRESS.md`
- `docs/DECISIONS.md`
