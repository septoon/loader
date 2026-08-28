# Progress

## 2026-08-29 — torrent 502, pause без сброса hash-pass и удаление записей

Production job `a0c9c780-0d78-4e7b-80ad-5cc26e79133d` дважды оборвал проверку файла `In.the.Grey…avi`. Причина `HTTP 502` подтверждена по PM2 error log: обычный peer disconnect вызывал необработанный `UTP_ECONNRESET` из `utp-native@2.5.3`, Node завершался с code 1, PM2 перезапускал Loader, а несериализуемый MD5/SHA-256 hash-pass начинался заново. До исправления зафиксированы два рестарта процесса; второй запуск дошёл до `666,894,336 / 1,575,770,112` bytes и затем завершился штатным inactivity error из-за отсутствия доступных пиров.

Release `ec981aa`:

- отключает только crash-prone native uTP transport через штатный `WebTorrent({ utp: false })`; BitTorrent продолжает работать по TCP, bounded piece-cache и tracker discovery сохранены;
- во время torrent hash-pass `Пауза` больше не abort-ит WebTorrent client и hash objects: PauseGate удерживает текущий поток в памяти, а `Продолжить` возобновляет его с той же byte-отметки, переподключает известные peers и немедленно вызывает tracker announce;
- во время передачи на Яндекс пауза по-прежнему использует durable upload checkpoint, потому что это безопаснее удержания незавершённого PUT;
- сохраняет старый `DELETE /api/jobs/:id` как `Отменить` для совместимости и добавляет отдельный `DELETE /api/jobs/:id/remove`; удаление доступно в активных, завершённых и ошибочных карточках, каскадно очищает job/files/events и служебные torrent metadata/cache, но не удаляет уже сохранённый файл с Яндекс Диска;
- активный удалённый import можно убрать из списка, но официальный API Яндекс Диска не гарантирует остановку уже запущенной remote operation; UI предупреждает об этом до удаления.

Проверка:

- `typecheck`, production build и `npm test`: 33/33 локально; тот же комплект 33/33 выполнен на VPS перед первой выкладкой;
- mobile Browser QA `390×844`: `Удалить` доступно во вкладках `Активные`, `Завершённые`, `Ошибки`; synthetic запись удалена, счётчик изменился `1 → 0`, console errors отсутствуют;
- production delete smoke: `204`, synthetic completed job отсутствует после запроса;
- live torrent pause/resume: до паузы `245,366,784` bytes (`15.57%`), после завершения одной уже запрошенной bounded piece пауза стабилизировалась на `255,852,544` (`16.24%`), после `Продолжить` дошла до `312,475,648` (`19.83%`) без отката к нулю;
- после live pause/resume PM2 `loader` остался на том же PID с zero restarts; public health `ok`, новый asset `index-HDeECxLZ.js` доступен;
- старые release-каталоги `f24b1a3`, `feb2dcf`, `8c95789` удалены после проверки точных путей; shared runtime/SQLite не затронуты, rollback сохраняется.

## 2026-08-28 — VK Видео, защищённый pull-relay и компактный mobile UI

Production job со ссылкой `vkvideo.ru/video-221995703_456240730` ошибочно имел `source_kind=direct-url`, имя `video-221995703_456240730` без расширения и завершался ошибкой Yandex remote import. Причина подтверждена по всему data path: Loader отправлял HTML-страницу VK в Yandex `/resources/upload`; даже извлечённый progressive URL нельзя передать напрямую, потому что он подписан с `srcIp` и требует browser headers. Контрольный прямой import извлечённого URL вернул `failed`, metadata destination — `404`.

Release `feb2dcf`:

- распознаёт VK/VK Video URL, нормализует его к публичной mobile-странице и через pinned standalone `yt-dlp 2026.07.04` получает `Изгой (2000) 4К`, 1080p, 8626 секунд и точный размер `3,755,022,717` bytes;
- принимает только progressive MP4 с публичного allowlisted VK CDN; yt-dlp запускается через `execFile` без shell, cookies и пользовательского config, а signed URL и заголовки не сохраняются и не логируются;
- создаёт job-scoped HMAC Basic-auth relay `/vk-import/:jobId`; Яндекс получает media через VPS с backpressure/range, но полный файл не staging-ится ни на диск, ни в RAM;
- обрабатывает VK как remote import: operation checkpoint сохраняется, active pause/cancel не имитируются, Source/Yandex metrics честно помечаются как не измеряемые;
- на телефоне полностью скрывает дублирующий sidebar/bottom bar; status tabs остаются в карточке загрузок, composer стал короче, а карточки по умолчанию свёрнуты до названия и прогресса. «Состояние» открывается по индикатору Яндекс Диска, выход перенесён в это окно.

Проверка:

- локально и на VPS: tests `30/30`, typecheck и production build passed;
- реальный resolver на Mac и VPS вернул одинаковые title/size/1080p; VPS source range 1 МиБ достиг `7.99 MB/s`, production authenticated relay range — `206`, 1 МиБ за `0.163 s` (`6.42 MB/s`);
- официальный `yt-dlp_linux` проверен по release `SHA2-256SUMS`; SHA-256 `6bbb3d314cde4febe36e5fa1d55462e29c974f63444e707871834f6d8cc210ae`;
- Browser QA `390×844` и `1440×900`: VK analysis показывает настоящее название, размер и destination; mobile sidebar отсутствует, horizontal overflow отсутствует, console errors/warnings отсутствуют, desktop scaffold сохранён;
- production job `afc80f03-fe0e-4837-971b-ae4f2dfd544e` создан как `vkvideo`; Yandex сначала получил challenge `401`, затем открыл authenticated GET relay, operation checkpoint сохранён, статус `transferring`, error null;
- public assets содержат новый VK/UI build, health `ok`, PM2 `loader`/`loader-vlc` online с zero restarts на `feb2dcf`, VLC unauthenticated contract остаётся `401`.

## 2026-08-28 — совместимый каталог для VLC 3.0.23 на macOS/iOS

Production access log установил точную причину клиентского отказа: оба пользовательских VLC достигали `/vlc/`, проходили Basic auth как `vlc`, выполняли обычный `GET` и получали `405`. Реализованный WebDAV корректно отвечал только на `PROPFIND`, тогда как ввод URL через «Открыть сетевой поток» в VLC 3.0.23 трактует адрес как media/playlist MRL.

Release `f24b1a3` сохраняет WebDAV `PROPFIND/GET file/HEAD/range`, а `GET` или `HEAD` каталога `/vlc/` возвращает динамический XSPF со всеми поддерживаемыми audio/video из `/Media` рекурсивно. Плейлист ограничен 10 000 объектами и глубиной 32, не содержит пароля и не кешируется. Файлы по-прежнему читаются range-stream через официальный Yandex Disk API без staging.

Проверка:

- targeted test, полный `npm test` 27/27, typecheck и production build passed;
- production: `GET /vlc/` → `200 application/xspf+xml`, `HEAD` → `200`, `PROPFIND` → `207`;
- XSPF содержит актуальный `Мастер игры, 2 сезон, 7 выпуск.ts`; его range вернул `206`, `564` bytes, TS sync `0x47` на offsets `0/188/376`;
- установленный macOS VLC `3.0.23` в headless smoke разобрал XSPF, выбрал элемент, получил `206`, активировал TS demux и прочитал `5,599,232` bytes до намеренной остановки через 3 секунды;
- PM2 `loader`/`loader-vlc` online, zero restarts, public health `ok`.

## 2026-08-28 — Rutube/Yandex bottleneck, checkpointed upload и VLC `/Media`

Пользовательская Rutube-задача `e3191cc3-4e2d-4277-80ca-e1a6be4eb052` установила реальную причину неработающей передачи. Один PUT на `1,390,208,864` bytes трижды оборвался через 78–121 минут; upload session не подтвердила локальный offset, поэтому worker начинал с нуля и в итоге получил `fetch failed`.

Production-профиль выполнен до изменения транспорта:

- 72 HLS GET из начала/середины/конца: `62,064,064` bytes за `1.487 s`, source `39.8 MiB/s`;
- один 8-MiB Yandex PUT: `64.782 s`, `126.5 KiB/s`; 32 writes по 256 KiB, максимальная write pause `30.2 ms`;
- один 32-MiB Yandex PUT: `256.853 s`, `127.6 KiB/s`; TCP `rwnd_limited=98.8%`, два writes более 1 s, максимум `31.805 s`;
- реальный `Content-Range 3 × 8 MiB`: ответы `202/202/201`, `194.357 s`, `126.4 KiB/s`; body feed `0.05–0.20 s`, ожидание Yandex response `63.9–66.1 s` на range;
- в Loader нет штатного throttling: задержки 400/750 ms используются только для retry/recovery.

Вывод: источник и сеть VPS не ограничивают текущую передачу; bottleneck — receive/commit pipeline upload endpoint Яндекс Диска. Старое поле «Скорость» смешивало source iterator с downstream backpressure и фактически показывало Yandex limit.

Release `c6fe2c8` (основной checkpointed transport из `6330399` плюс retry оборванного source body):

- Rutube и torrent передают последовательные `Content-Range` максимум по 8 MiB; progress обновляется только после `202/201`;
- source сначала заполняет отдельный bounded RAM-buffer максимум 8 MiB, поэтому Source Speed и Yandex Upload Speed измеряются независимо;
- SQLite/API/UI хранят Source Speed, Yandex Upload Speed, Bottleneck, заполнение буфера, полный PUT time и суммарный write wait;
- pause/resume текущей задачи через production API вернули `200/200`; `HEAD` восстановил точный offset `16,777,216`, без повторного hash-pass и отката к нулю;
- public health, production assets, authenticated metrics API и WebDAV проверены; `/vlc/` без auth возвращает `401`, authenticated `PROPFIND` перечисляет Movies/TV/Unsorted, range GET возвращает `206` и 64 bytes;
- после transient `terminated` на `763,363,328` bytes source-range теперь до четырёх раз открывается заново с той же подтверждённой отметки; это применяется и к Rutube, и к torrent;
- `npm test`: 27/27, server/web typecheck и production build passed; PM2 `loader` и `loader-vlc` используют `c6fe2c8`, zero restarts.

Та же Rutube-задача продолжилась с `763,363,328` bytes без повторной передачи уже принятых частей и завершилась `2026-08-28T10:23:20.759Z`: `1,390,208,864 / 1,390,208,864`, error null. Независимая Disk metadata вернула exact size и MD5 `d85a6dd2049134623e6cbe01a460f7f8`; official download и WebDAV дали `206 bytes 0-563/1390208864`, а TS sync byte равен `0x47` на offsets `0/188/376`. WebDAV `PROPFIND /vlc/TV/` вернул `207` и содержит финальный файл.

Отдельно проверен возможный обход медленного PUT: официальный remote import забрал существующий 16-MiB файл через HTTPS WebDAV/VPS за `6.831 s`, `2,455,993 B/s` (`2.34 MiB/s`) с тем же MD5 — примерно в 18.7 раза быстрее measured PUT. Для обычных direct URL этот путь уже используется. Автоматический Rutube pull-relay пока не включён: без отдельного lifecycle он уберёт достоверный range checkpoint и текущую безопасную pause/resume семантику; результат benchmark зафиксирован для следующего ограниченного изменения.

Два ошибочно импортированных Rutube HTML-файла (`bc99…` и `a843…`) и synthetic `loader-e2e-restart.mp4` перемещены в корзину Яндекс Диска и подтверждены как отсутствующие. Диагностические VPS-файлы удалены; оставлены current `c6fe2c8` и rollback `6330399`, свободно `1.8 GiB`.

## 2026-08-27 — диагностика зависшей пользовательской torrent-задачи

На production подтверждены две независимые причины наблюдаемого поведения:

- `BoundedPieceStore` при заполнении 128-МиБ cache полностью снимал torrent selection. Если нужная reader-у piece ещё не пришла, reader ждал её, но WebTorrent уже не мог её запросить. У пользовательской задачи cache заполнился удалёнными pieces, hash-pass оставался без видимого прогресса и заблокировал следующую задачу в однопоточной очереди.
- Web client добавлял `Content-Type: application/json` к пустым `POST /pause` и `DELETE` запросам. Fastify возвращал `400 Body cannot be empty when content-type is set to application/json` до вызова pause/cancel handler.

Локальный hotfix:

- при заполнении cache сохраняет выбранным текущее read-window и переставляет его при продвижении cursor;
- job-scoped cache от предыдущего process instance очищается при восстановлении, потому что новый WebTorrent bitfield не может доверять непроверенным файлам pieces;
- `.torrent` после смены release ищется по `jobId` внутри канонического shared runtime, а не по сохранённому абсолютному пути старого release;
- hash-pass записывает реальный progress/speed вместо вечных `0 Б`;
- ожидание следующей piece ограничено тем же 10-минутным inactivity timeout, после которого задача освобождает очередь с понятной ошибкой об отсутствии раздающих пиров;
- раннее завершение torrent iterator больше не может молча дать digest неполного файла;
- JSON `Content-Type` ставится только при наличии тела запроса, поэтому pause/cancel доходят до API.

Проверка локального hotfix:

```bash
npm run typecheck
npm run build
npm test
npm run poc:torrent
```

- TypeScript и production build: passed.
- 10 tests passed, включая regression на активное read-window заполненного cache и пустые pause/cancel запросы.
- 256 МиБ bounded PoC: passed; SHA-256 совпал, peak cache 7 МиБ при лимите 24 МиБ, forced disconnect/retry завершён.
- Production пока остаётся на `efcd8b0`: commit/push/deploy требуют отдельного явного разрешения пользователя.

Для общего доступа VLC проверен вариант `rclone serve sftp` поверх Yandex backend: read-only каталог `/Media`, без полного staging и с единым SFTP-подключением в VLC. Это fallback, потому что медиабайты пойдут через VPS; прямой WebDAV Yandex сейчас не является надёжным общим знаменателем для стабильных VLC на iOS/tvOS/Android.

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
- Активный production release: `efcd8b0`; release собран на VPS из публичного GitHub checkout с проверкой точного commit SHA.
- Production password/session secret созданы локально в ignored `runtime/secrets/` с `0600`; Yandex token также остаётся только в ignored secret file.
- Release развернут в `/home/deploy/loader/releases/efcd8b0`, shared runtime подключён через symlink, зависимости установлены отдельным Node `v22.23.2`, WebTorrent зафиксирован как `3.0.21`.
- PM2-процесс `loader` пересоздан, чтобы убрать сохранённый абсолютный путь к удалённому release `7acde0f`; теперь script path и cwd указывают на `efcd8b0`, процесс online с нулём restart.
- `https://loader.lumastack.ru` опубликован через отдельный nginx vhost с отключённым buffering для SSE и proxy на `127.0.0.1:8787`. Let's Encrypt certificate действителен до `2026-11-25`, auto-renew включён.
- Public smoke: health `ok`, `storageConfigured: true`, `torrentAvailable: true`; manifest и PNG 192/512/180/32 отвечают `200`, размеры и maskable purpose совпадают. Production JS не содержит старый iOS `accept` filter.
- Временные upload-артефакты отсутствуют. Старый rollback `5a7a0d1` удалён; оставлены текущий `efcd8b0` и rollback `65fa83f`. Свободно `2.1G`, Loader использует около `98 MiB` RAM.

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
