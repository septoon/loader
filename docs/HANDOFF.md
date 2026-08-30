# Current state

Production release `44ccd19` активен на `https://loader.lumastack.ru`. PM2 `loader` и `loader-vlc` используют один release и shared runtime, оба online с zero restarts. Public `/api/health`: `ok`, storage configured, torrent available, active transfers `0`.

Причина прежнего `HTTP 502` устранена: `utp-native@2.5.3` дважды выбрасывал необработанный `UTP_ECONNRESET` и завершал Node. Torrent client теперь использует TCP (`utp: false`), сохраняя tracker discovery и bounded cache.

Single-file torrent теперь идёт быстрым Yandex remote pull: Loader публикует защищённый job-scoped relay, Яндекс забирает поток одним GET, а VPS хранит только bounded piece-cache. WebTorrent client планово заменяется каждые `48 MiB` внутри того же HTTP stream, поэтому зависший peer state не обнуляет Yandex operation. Multi-file/fallback transport сохраняет one-pass `Content-Range` checkpoints. Удаление записей отделено от отмены и доступно во всех status tabs; оно не удаляет media с Яндекс Диска.

Ложный `нет доступных раздающих пиров` устранён в `279a295`. Прежний refresh сам разрывал подключённые wires, а три retry повторяли чтение внутри того же зависшего client state. Свежая production-диагностика нашла `41` peer с нужной piece `180` и получила её за 22 секунды. Теперь connected peers не разрываются; после одного полного inactivity timeout job переходит в активный `waiting`, текущий WebTorrent уничтожается и через 30 секунд создаётся fresh client. Waiting retry хранится в SQLite, переживает restart и не блокирует более новые queued jobs.

Rutube и torrent fallback не используют один многочасовой PUT. Source читается в bounded RAM-buffer максимум 8 MiB, затем отправляется отдельным Yandex `Content-Range`; каждый подтверждённый offset сохраняется durable. Полного media staging на VPS нет. `qBittorrent-nox` не установлен: обычный torrent client потребует место под весь payload, а защищённый relay уже даёт клиентоподобный peer recovery без full staging.

UI/API показывают раздельные Source Speed, Yandex Upload Speed и Bottleneck только там, где они достоверно измеримы. Для Yandex pull UI пишет `Импорт торрента Яндексом` и `Прогресс по байтам недоступен`, не показывает старую фазу `Проверка`, прежний PUT timing или выдуманные channel speeds.

Read-only медиатека доступна через HTTPS WebDAV `/vlc/` с отдельной Basic-auth учётной записью из ignored `runtime/secrets/vlc-sftp.env`. `PROPFIND`, `GET`, `HEAD` и byte ranges работают; writes/traversal/depth infinity запрещены. SFTP bridge также работает локально на 2022, но внешний порт блокирует UFW, поэтому клиентский путь — WebDAV 443.

Для VLC 3.0.23 тот же `GET /vlc/` дополнительно возвращает XSPF всей `/Media`: это исправляет `405` при вводе корневого URL через «Открыть сетевой поток» на macOS/iOS. Production headless VLC smoke подтвердил XSPF parsing, выбор текущего TS-файла, `206` и TS demux. WebDAV-клиенты по-прежнему используют `PROPFIND` без изменения контракта.

VK Видео больше не попадает в direct import как HTML. Resolver определяет настоящее название/размер и progressive MP4 до создания job. Signed media URL привязан к IP, поэтому Yandex забирает файл через `/vk-import/:jobId` с HMAC-derived Basic auth; relay поддерживает range/backpressure и не staging-ит файл. Standalone `yt-dlp 2026.07.04` хранится в shared tools, его SHA-256 проверен по официальному release manifest.

Мобильная нижняя навигация удалена: она дублировала status tabs и прыгала при scroll. Layout `44ccd19` использует compact columns до `1380 px`, card layout до `1024 px` и safe-area на iPhone. Проверены `1280`, `1024` и `390 px`: progress/status/actions не пересекаются, horizontal overflow отсутствует. Состояние и выход доступны через верхний индикатор Яндекс Диска.

# Completed torrent operation

Job `a0c9c780-0d78-4e7b-80ad-5cc26e79133d` сохранил `In.the.Grey.2026.D.P.WEB-DLRip.DD2.0.XviD-p3rr3nt.avi` в `/Media/Movies`.

- Size: `1,575,770,112` bytes.
- До `0c33cfb` последняя попытка достигла `704,643,072` bytes (`44.72%`), но hash checkpoint отсутствовал; эту старую отметку криптографически продолжить было невозможно, поэтому после deploy произошёл последний одноразовый старт с нуля.
- Новый checkpoint впервые сохранён на `37,748,736` bytes. Первый controlled PM2 restart записал событие `Проверка продолжена с 36.0 МиБ`, затем дошёл до `255,852,544` без отката.
- Legacy hash-pass завершён: MD5/SHA-256 сохранены, после чего прежняя архитектура начала Yandex phase с нулевого remote offset. Release `ff5f28a` больше не повторяет эту фазу для новых torrent jobs.
- Прежний direct PUT был измерен отдельно: torrent source `25,451,525 B/s`, Yandex upload `~130,952 B/s`, один 8-МиБ PUT около `64 s`; chunk size и backpressure не были узким местом.
- Releases `332a51e` → `98b7714` → `81b508a` → `d990704` перевели single-file torrent на Yandex pull, разделили relay на bounded windows и добавили planned WebTorrent rotation каждые `48 MiB` до peer-state stall.
- Финальный защищённый GET занял `621.523 s`, средняя скорость `2.418 MiB/s`; job завершён `1,575,770,112 / 1,575,770,112`, error null.
- Независимые Yandex metadata: exact size `1,575,770,112`, MD5 `731b4d884125bf255d1d06ec155eef1e`.

# Completed operation

Job `e3191cc3-4e2d-4277-80ca-e1a6be4eb052` сохраняет `Мастер игры, 2 сезон, 7 выпуск.ts` в `/Media/TV`.

- Expected size: `1,390,208,864` bytes.
- MD5: `d85a6dd2049134623e6cbe01a460f7f8`.
- SHA-256: `5fa4…7460` (полное значение есть в SQLite).
- Segment checkpoint: 1924 HLS segment sizes, сохранён в SQLite.
- Final state: `completed`, `1,390,208,864 / 1,390,208,864`, error null.
- Independent Yandex metadata: exact size, MD5 `d85a6dd2049134623e6cbe01a460f7f8`.
- Official download and authenticated WebDAV: range `206`, `564` bytes, exact match; TS sync `0x47` at `0/188/376`.
- Live measurements before completion: Source около `17–30 MiB/s`, Yandex около `128 KiB/s`, обычный PUT около `64 s`, bottleneck `yandex`.

На `54.91%` CDN source оборвал body с `terminated`; PM2 не перезапускался. Release `c6fe2c8` повторяет такой source-range до четырёх раз с той же durable Yandex отметки. Эта задача была возобновлена с `763,363,328` bytes и дошла до конца без отката.

# Final validation

- `npm test`: 40/40; server/web typecheck and production build passed локально и в exact VPS release, включая authenticated Range torrent relay, fresh peer selection, persistent waiting retry, one-pass fallback, TCP transport, delete API, VK relay и directory XSPF regressions.
- Browser QA на `1280×900`, `1024×768` и `390×844`: horizontal overflow отсутствует, actions остаются внутри карточки, progress label не пересекает track, mobile safe-area применён.
- Public health `200`, current assets `index-DRuWKx1L.js`/`index--COYOqMH.css`, PM2 `loader`/`loader-vlc` online с zero restarts.
- Production WebDAV: authenticated `PROPFIND 207`, видны `/vlc/Movies/` и `/vlc/TV/`; range нового AVI `206`, ровно `564` bytes.
- Synthetic media удалён recoverably в Yandex Trash; remote pull test destination отсутствует.
- На VPS активен `44ccd19`; rollback — `d990704`.

# Known limits

- Yandex direct upload endpoint фактически ограничивает fallback PUT-контур примерно `126–128 KiB/s`; изменение chunk size с 8 до 32 MiB скорость не меняет. Single-file torrent обходит его через remote pull и на завершённом файле дал в среднем `2.418 MiB/s`.
- Direct remote import быстрее и остаётся first choice для стабильных прямых HTTP URLs. Rutube API этой записи отдаёт только HLS, прямого progressive media URL нет.
- Torrent pull автоматически используется только для single-file torrent. Для Rutube нужен отдельный short-lived relay lifecycle с корректными pause/cancel/recovery; он автоматически не включён вслепую.
- VK pull-relay не даёт достоверно разделить Source Speed и Yandex Upload Speed в одном demand-driven stream, поэтому UI не показывает выдуманные значения. Yandex remote import также не сообщает byte progress.
- Direct remote import сохраняет crash-window между ответом Yandex и записью operation URL; backup/retention SQLite/shared runtime также остаются будущей эксплуатационной задачей.
- Torrent hash checkpoint зависит от pinned `hash-wasm 4.12.0`. Обновлять библиотеку во время незавершённой one-pass/legacy задачи можно только после проверки совместимости сериализованного state.
- Восстановление offset без готовых hashes подтверждено реальным `HEAD` текущей Yandex upload session, но этот контракт не описан официальной документацией Yandex. При его изменении Loader завершит job безопасной ошибкой, не будет считать неподтверждённые bytes записанными и не включит скрытый full staging.
- `npm audit --omit=dev` показывает четыре high findings в pin `webtorrent@3.0.21 -> ip@2.0.1`; reachability ограничена tracker client path, automatic force-fix запрещён.

# Relevant files

- `src/server/rutube.ts`
- `src/server/vk-video.ts`
- `src/server/vk-relay.ts`
- `src/server/rutube-transfer.ts`
- `src/server/torrent-transfer.ts`
- `src/server/transfer-buffer.ts`
- `src/server/yandex-disk.ts`
- `src/server/database.ts`
- `src/server/media-webdav.ts`
- `src/server/media-sftp-server.ts`
- `src/web/components/JobsPanel.tsx`
- `docs/DECISIONS.md`
- `docs/PLAN.md`
- `docs/PROGRESS.md`
