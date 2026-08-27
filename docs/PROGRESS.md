# Progress

## 2026-08-27 — production torrent/magnet, восстановление и финальный UI

Production-контур теперь принимает прямые HTTP(S) URL, magnet и `.torrent`; очередь, checkpoints и состав файлов переживают закрытие браузера и рестарт процесса.

### Интерфейс

- Сохранён исходный каркас: боковая навигация, composer источника, status tabs, табличная очередь и раскрытые сведения задачи.
- UI полностью переведён на русский, включая название PWA, login, document title и operational copy.
- Новый пользовательский арт подключён как PWA icon: PNG 192×192 и maskable 512×512; отдельно подготовлены Apple Touch Icon 180×180 и favicon 32×32.
- У file picker удалён MIME/extension `accept`: iOS Files больше не блокирует `.torrent` из-за ненадёжного UTType-сопоставления; после выбора по-прежнему проверяются расширение и bencode-содержимое.
- Каркас сохранён: sidebar, composer, tabs, очередь и раскрываемые сведения. Добавлены цельные surface-карточки, status-pill, рабочее окно состояния, drag-and-drop `.torrent`, реальный список файлов и responsive mobile navigation.
- Direct URL, magnet и `.torrent` проходят анализ до создания задачи; для auto-каталога magnet UI явно сообщает, что `Фильмы`/`Сериалы` определятся после metadata.
- Актуальный визуальный reference: `docs/design/loader-russian-concept.png`.

### Backend и data path

- Fastify API: signed HttpOnly session cookie, login rate limit, authenticated jobs/events/SSE endpoints.
- SQLite `STRICT` + WAL хранит jobs, events, per-file state/hash и Yandex operation/upload checkpoints.
- `.torrent` принимается multipart endpoint с лимитом 4 MiB; metadata хранится в ignored `runtime/torrents/` с `0600`. Magnet source и tracker query не возвращаются клиенту и не пишутся в application log.
- WebTorrent `3.0.21` читает выбранные видео и companion-файлы последовательно через `BoundedPieceStore`. Cache ограничен bytes, pending pieces и резервом свободного диска; полного staging нет.
- Multi-file torrent сохраняет безопасную структуру подпапок, отбрасывает sample и автоматически выбирает `/Media/Movies` либо `/Media/TV`; конфликтующий существующий файл не перезаписывается.
- Перед upload выполняется отдельный bounded hash-pass для полного MD5/SHA-256. Затем continuous PUT использует сохранённый upload URL; после сбоя HEAD даёт server-authoritative offset, и source повторно открывается с него.
- Torrent transfer поддерживает настоящие pause/cancel/resume. Direct remote import по-прежнему управляется Яндекс Диском и не получает фиктивных active pause/cancel semantics.
- Один `JobRunner` обрабатывает одну большую задачу, восстанавливает direct operation polling и torrent per-file checkpoint после рестарта, затем сверяет remote `type`, `size` и `md5`.
- Source URL не возвращается клиенту целиком: query скрыт из `sourceLabel`, ошибки очищаются от URL/OAuth values.
- SSRF validation запрещает credentials, нестандартные порты, local/private/reserved IPv4/IPv6, включая IPv4-mapped IPv6. Destination и filename нормализуются до каталогов `/Media/*`.
- Активный remote import нельзя безопасно pause/cancel через подтверждённый API; UI не имитирует это действие. Queue/paused/failed jobs поддерживают pause/resume/cancel/retry.

### Проверка

```bash
npm run typecheck
npm run build
npm test
npm audit --omit=dev
```

- TypeScript server/web: passed.
- Production Vite build: passed; client bundle 215.59 kB, gzip 67.20 kB.
- PWA manifest ссылается на существующие PNG-иконки 192×192 и 512×512; production build включает manifest, Apple Touch Icon и favicon.
- 8 tests passed: authenticated API/multipart intake, SQLite persistence/events, URL normalization, credentials, executable magnet validation/redaction, safe torrent file selection, URL/OAuth redaction и SSRF IPv4/IPv6 regression.
- `npm run poc:torrent`: 256 MiB synthetic source, injected disconnect/retry, SHA-256 match, cache limit 24 MiB, фактический peak cache 7 MiB.
- Browser QA через in-app Browser прошёл на `1440x900` и `390x844`: login, magnet analysis, modal, tabs, desktop/mobile render, нет horizontal overflow, framework overlay и console warnings/errors.
- `npm audit --omit=dev`: 4 high findings остаются в зафиксированном WebTorrent `3.0.21` path через `ip@2.0.1`; `npm audit fix --force` предлагает недопустимый downgrade до `webtorrent@0.7.3`. Reachability/изоляция описаны ранее.

### Не проверено в этом шаге

- Production worker не запускал пользовательский magnet/`.torrent` против реального Яндекс Диска: source должен быть легальным и контролируемым. Bounded source и Yandex resume подтверждены отдельными реальными/локальными PoC, но их новый production glue остаётся live-E2E риском.
- Не выполнен kill/restart test живой torrent-задачи. Hashes и upload URL сохраняются, поэтому worker повторяет metadata/hash pass при необходимости и получает authoritative offset, но это ещё нужно подтвердить на безопасном target.
- Для direct remote import остаётся малое crash-window между ответом API и записью operation URL.

### Git и deployment state

- Репозиторий опубликован: `https://github.com/septoon/loader`, ветка `main`. Secrets/runtime исключены.
- Активный production release: `65fa83f`; archive `/tmp/loader-release-65fa83f.tgz`: `179935` bytes, SHA-256 `ac8097ba11ad040bc27a57d4be8ee54bf3d06bfd595a30a92f7082a75ed22015`.
- Production password/session secret созданы локально в ignored `runtime/secrets/` с `0600`; Yandex token также остаётся только в ignored secret file.
- Release развернут в `/home/deploy/loader/releases/65fa83f`, shared runtime подключён через symlink, зависимости установлены отдельным Node `v22.23.2`, WebTorrent подтверждён как `3.0.21`.
- PM2-процесс `loader` online; локальный/public health возвращает `storageConfigured: true`, `torrentAvailable: true`, `activeTransfers: 0`. PM2 restart count включает контролируемые restart recovery тесты.
- `https://loader.lumastack.ru` опубликован через отдельный nginx vhost с отключённым buffering для SSE и proxy на `127.0.0.1:8787`. Let's Encrypt certificate действителен до `2026-11-25`, auto-renew включён.
- Public smoke: health `ok`, authenticated session `200`, session cookie подтверждена, `/api/jobs` возвращает пустую очередь, SSE отдаёт initial snapshot, JS/CSS отвечают `200`.
- Временные upload-артефакты и ограниченное sudo-правило удалены после deploy. Старый `7acde0f` удалён; оставлены текущий `65fa83f` и один rollback `5a7a0d1`. После E2E свободно `2.2G`, Loader использует около `97 MiB` RAM.

### Production torrent restart E2E

- Синтетический легальный `.mp4` размером `16 MiB` передан magnet-задачей `4995d49e-776c-42ea-ac94-7dc891c4a20c` в `/Media/Movies/loader-e2e-restart.mp4`.
- E2E обнаружил два production edge case: зависание ожидания piece при cancel и необходимость повторно подключать explicit `x.pe` после metadata. Исправления: abort-aware iterator и reconnect explicit peer (`5a7a0d1`, `65fa83f`).
- Worker принудительно перезапущен во время передачи. Та же задача сохранила hashes/upload URL, получила server-authoritative offset `1.4 MiB`, продолжила работу и завершилась `completed`.
- Итог: `16,777,216` bytes; MD5 `2c7ab85a893283e98c931e9511add182`; SHA-256 `080acf35a507ac9849cfcba47dc2ad83e01b75663a516279c8b9d243b719643e`. Yandex metadata совпала.
- Официальный временный download URL вернул `206`, `Content-Range: bytes 0-31/16777216` и 32 bytes с `downloader.disk.yandex.ru`; VLC data path подтверждён без proxy VPS.
- Неуспешные синтетические job records и локальный seeder workspace удалены. Удалённый успешный test file оставлен на Яндекс Диске, поскольку удаление не было отдельно разрешено.

## 2026-08-26 — реальный Yandex Disk transport подтверждён

OAuth завершён штатно. Token хранится только в `runtime/secrets/yandex-token` с правами `0600`; в Git, browser automation и logs он не попадал.

Фактическая квота API на момент теста:

| Метрика | Результат |
| --- | ---: |
| Total | 1,110,249,046,016 bytes |
| Used до тестов | 18,400,946,029 bytes |
| Free до тестов | 1,091,848,099,987 bytes |

### Single streaming PUT

- Размер: 8 MiB.
- Полный staging: 0 bytes.
- Yandex создал `/Loader-PoC/single-8MiB-20260826175142.bin`.
- Remote size: 8,388,608 bytes.
- Remote/expected MD5: `c2201f8794bc3c10d9f704dcc36e5c13`.
- Local SHA-256: `e2ee81b5319c58acbb3249559942382538640ecbd179420641c9c6432d1278e5`.

### Последовательные Content-Range

- Размер: 24 MiB, части по 8 MiB.
- Ответы uploader: `202`, `202`, `201`.
- Remote size: 25,165,824 bytes.
- Remote/expected MD5: `e8f86bf2020c992ac281ff1c6bb2bfce`.
- Полный staging: 0 bytes.

Механизм работает, но фиксированные части не выбраны основным production transport: официальный Yandex SDK использует непрерывный PUT и дозагрузку остатка с server-authoritative offset.

### Forced disconnect и resume

Наивный повтор диапазона после обрыва вернул `412`. В ответе не было `Range`, `Upload-Offset` или body. Продолжение с локально подсчитанного количества отданных байтов также вернуло `412`.

Подтверждён рабочий механизм из официального Yandex Disk Java SDK:

1. `HEAD` на тот же upload URL.
2. Заголовки `Etag=<full md5>`, `Sha256=<full sha256>`, `Size=<full size>`.
3. `Content-Length` ответа — server-authoritative uploaded offset.
4. Resume PUT: `Content-Range: bytes <offset>-<size-1>/<size>` и тело от offset до EOF.

24 MiB test: после обрыва server offset стабилизировался на 4,189,876 bytes; остаток принят с `201`, итоговый MD5 совпал.

Большой контрольный test:

```bash
YANDEX_POC_MIB=128 YANDEX_POC_ABORT_MIB=8 YANDEX_POC_TIMEOUT_MIN=30 npm run poc:yandex -- resume
```

| Метрика | Результат |
| --- | ---: |
| Размер | 128 MiB |
| Локально отдано до обрыва | 8,388,608 bytes |
| Стабильный server offset | 8,384,180 bytes |
| Расхождение local/server | 4,428 bytes |
| Resume response | `201` |
| Remote size | 134,217,728 bytes |
| Remote/expected MD5 | `126d4b948d67f098a42b39343f37b61f` |
| Local SHA-256 | `ecdca49e3eed88232246797e7d4d87eadeb67a07503d2471bfddde9faf785bbb` |
| Duration | 1,035.64 s |
| Average throughput | 0.124 MiB/s |
| Baseline RSS | 47,448,064 bytes |
| Peak RSS | 99,827,712 bytes |
| RSS delta | 52,379,648 bytes |
| Staging | 0 bytes |

Отдельная runtime-проверка во время transfer показала около 61 MiB RSS и 4 KiB в `runtime/` — media-файл локально не создавался.

### Yandex remote import

- Source: публичный HTTPS test endpoint Cloudflare, 8 MiB.
- Yandex operation завершилась `success` за 2.29 s.
- Remote size: 8,388,608 bytes.
- Loader transferred: 0 bytes.
- Staging: 0 bytes.
- Remote MD5: `720d95d2d32fd5bfed5fcc7dc90a475f`.

Remote import выбран первым transport для стабильных прямых HTTP URL. Yandex сам выполняет server-to-server transfer; Loader только создаёт и poll-ит operation, затем проверяет metadata.

### Оставшееся ограничение resume

Для `HEAD` нужны полные MD5, SHA-256 и size. У torrent нет готовых per-file MD5/SHA-256. При сетевой ошибке worker должен закончить hash-pass по source без staging, получить server offset и заново открыть source с этого offset. Это сохраняет диск, но может повторно скачать suffix. После process crash без сохранённого hash state может потребоваться полный hash-pass.

### Security audit WebTorrent

`npm audit` показывает high advisory в `ip@2.0.1`. Проверка reachability показала, что зависимость используется только в UDP parser tracker **server** (`bittorrent-tracker/lib/server/parse-udp.js`) и вызывает `toString`, а Loader использует tracker client. Уязвимый `isPublic` path не вызывается. Finding остаётся supply-chain риском: torrent worker должен быть изолирован, сервер tracker не запускается, версия фиксируется, обновления проверяются contract tests.

## 2026-08-26 — torrent transport PoC подтверждён

Реализован локальный PoC `torrent -> bounded piece-cache -> mock resumable upload` на легальном синтетическом sparse-файле.

Контрольный запуск:

```bash
POC_SOURCE_MIB=512 POC_CACHE_MIB=24 POC_FAIL_CHUNK=211 POC_TARGET_DELAY_MS=35 POC_DOWNLOAD_MIBPS=16 npm run poc:torrent
```

Фактический результат:

| Метрика | Результат |
| --- | ---: |
| Размер source | 512 MiB |
| Лимит piece-cache | 24 MiB |
| Peak disk cache | 13 MiB |
| Cache/source | 2.54% |
| Baseline RSS receiver | 91.0 MiB |
| Peak RSS receiver | 212.9 MiB |
| Рост RSS | 121.9 MiB (~128 MB) |
| Лимит download | 16 MiB/s |
| Фактическая скорость | 15.94 MiB/s |
| Принудительный обрыв | chunk 211 |
| Retry | 1, успешно |
| Длительность | 32.12 s |
| SHA-256 source/target | совпал |
| SHA-256 | `9acca8e8c22201155389f65abbf6bc9723edc7384ead80503839f49dcc56d767` |

### Что было исправлено в ходе PoC

- Устранено накопление pending pieces в RAM при медленном downstream.
- Добавлены pause/deselect и повторный select около текущего read cursor.
- Ограничено число pending pieces и удаляются слишком далёкие pieces.
- Исправлена race в учёте cache bytes при параллельном release/commit.
- Принудительный разрыв mock upload приводит к повтору того же chunk, после чего итоговый hash совпадает.

### Что PoC доказывает

- Torrent source можно читать последовательно с ограниченным дисковым cache.
- Backpressure удерживает скорость около заданного лимита и не требует полного staging.
- Локальный chunk retry после сетевого обрыва сохраняет целостность результата.

### Что PoC не доказывает

- Что Yandex Disk принимает такой же chunk/`Content-Range` протокол.
- Что один Yandex upload URL переживает разрыв и позволяет продолжить с нужного offset.
- Что большой файл разрешён конкретным тарифом и помещается в доступную квоту.
- Что private API WebTorrent останутся совместимыми после обновления зависимости.

### Следующий этап

Результаты реального Yandex test находятся в разделе выше. Следующий этап — production backend/frontend, persistent jobs и соединение подтверждённого torrent source с подтверждённым Yandex uploader.
