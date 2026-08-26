# Current state

Transport architecture подтверждена реальными тестами: HTTP remote import, Yandex continuous streaming/resume и bounded torrent source работают без полного staging.

Production-контур реализован: Fastify API/SSE, signed single-user session, SQLite WAL jobs/events/files, direct URL remote import, magnet/`.torrent` bounded transport, Yandex HEAD resume и адаптивный русскоязычный React/Vite PWA.

# Last completed step

`npm run typecheck`, `npm run build`, 8 tests и 256 MiB bounded torrent PoC проходят. Browser QA: `1440x900` и `390x844`, вход, magnet analysis, status modal, tabs, без overflow и console errors.

# Current blocker

Блокера реализации нет. Остался live-E2E риск production glue: безопасный legal torrent нужно реально передать на Яндекс Диск, оборвать процесс и подтвердить восстановление после рестарта.

Для direct remote import остаётся crash-window между получением operation URL от Яндекс и её сохранением в SQLite. Нужен реальный restart test незавершённой operation и idempotent recovery policy. Активную remote-import operation подтверждённым Disk API сейчас нельзя безопасно pause/cancel; UI это не имитирует.

# Next action

Развернуть текущую версию на VPS, проверить health/auth/static/nginx. Затем на отдельном безопасном target провести live torrent transfer + kill/restart recovery и удалить тестовый файл после явного разрешения.

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
