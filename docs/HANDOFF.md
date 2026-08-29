# Current state

Production release `0c33cfb` активен на `https://loader.lumastack.ru`. PM2 `loader` и `loader-vlc` используют один release и shared runtime. Public `/api/health`: `ok`, storage configured, torrent available; активен пользовательский torrent hash-pass. У `loader` один контролируемый restart, выполненный для live-проверки checkpoint, незапланированных падений после выкладки нет.

Причина прежнего `HTTP 502` устранена: `utp-native@2.5.3` дважды выбрасывал необработанный `UTP_ECONNRESET` и завершал Node. Torrent client теперь использует TCP (`utp: false`), сохраняя tracker discovery и bounded cache.

Пауза torrent во время hash-pass сохраняет WebTorrent client и MD5/SHA-256 state в памяти. Дополнительно `hash-wasm 4.12.0` сохраняет оба hash state в SQLite каждые 4 МиБ и перед graceful stop. Retry/restart/deploy продолжают с checkpoint, переподключая peers/tracker, а не начинают с нуля. При upload пауза остаётся Yandex-checkpoint-based. Удаление записей отделено от отмены и доступно во всех status tabs; оно не удаляет media с Яндекс Диска.

Rutube и torrent больше не используют один многочасовой PUT. Source читается в bounded RAM-buffer максимум 8 MiB, затем отправляется отдельным Yandex `Content-Range`; каждый `202/201` сохраняет durable offset. Полного staging на VPS нет.

UI/API показывают раздельные Source Speed, Yandex Upload Speed и Bottleneck. Progress/ETA используют только подтверждённые Yandex bytes. Технические поля сохраняют buffer fill, последний PUT time и суммарный write wait.

Read-only медиатека доступна через HTTPS WebDAV `/vlc/` с отдельной Basic-auth учётной записью из ignored `runtime/secrets/vlc-sftp.env`. `PROPFIND`, `GET`, `HEAD` и byte ranges работают; writes/traversal/depth infinity запрещены. SFTP bridge также работает локально на 2022, но внешний порт блокирует UFW, поэтому клиентский путь — WebDAV 443.

Для VLC 3.0.23 тот же `GET /vlc/` дополнительно возвращает XSPF всей `/Media`: это исправляет `405` при вводе корневого URL через «Открыть сетевой поток» на macOS/iOS. Production headless VLC smoke подтвердил XSPF parsing, выбор текущего TS-файла, `206` и TS demux. WebDAV-клиенты по-прежнему используют `PROPFIND` без изменения контракта.

VK Видео больше не попадает в direct import как HTML. Resolver определяет настоящее название/размер и progressive MP4 до создания job. Signed media URL привязан к IP, поэтому Yandex забирает файл через `/vk-import/:jobId` с HMAC-derived Basic auth; relay поддерживает range/backpressure и не staging-ит файл. Standalone `yt-dlp 2026.07.04` хранится в shared tools, его SHA-256 проверен по официальному release manifest.

Мобильная нижняя навигация удалена: она дублировала status tabs и прыгала при scroll. Composer и collapsed job card помещаются в один экран `390×844`; desktop sidebar сохранён. Состояние и выход доступны через верхний индикатор Яндекс Диска.

# Active torrent operation

Job `a0c9c780-0d78-4e7b-80ad-5cc26e79133d` проверяет `In.the.Grey.2026.D.P.WEB-DLRip.DD2.0.XviD-p3rr3nt.avi` для `/Media/Movies`.

- Size: `1,575,770,112` bytes.
- До `0c33cfb` последняя попытка достигла `704,643,072` bytes (`44.72%`), но hash checkpoint отсутствовал; эту старую отметку криптографически продолжить было невозможно, поэтому после deploy произошёл последний одноразовый старт с нуля.
- Новый checkpoint впервые сохранён на `37,748,736` bytes. Controlled PM2 restart сменил PID и новый процесс записал событие `Проверка продолжена с 36.0 МиБ`, затем дошёл до `255,852,544` без отката.
- Последний live snapshot: `310,378,496 / 1,575,770,112` (`19.70%`), source около `5.2 MB/s`, status `verifying`, error null. Если пиры снова перестанут отдавать нужную piece, Retry продолжит с последней 4-МиБ отметки.

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

- `npm test`: 35/35; server/web typecheck and production build passed локально и на VPS, включая cross-process torrent hash resume, повреждённый checkpoint, pause gate, TCP transport, delete API, VK relay и directory XSPF regressions.
- Mobile Browser QA `390×844`: delete доступен во всех трёх вкладках, synthetic row удаляется, console errors отсутствуют.
- Public health, current release, один controlled PM2 restart без отката torrent checkpoint, production delete smoke `204`, WebDAV auth contract and production assets verified.
- Synthetic media удалён recoverably в Yandex Trash; remote pull test destination отсутствует.
- На VPS активен `0c33cfb`, rollback-каталоги `ec981aa` и `a952d84` сохранены; свободно около `1.7 GiB`.

# Known limits

- Yandex upload endpoint фактически ограничивает этот контур примерно `126–128 KiB/s`; изменение chunk size с 8 до 32 MiB скорость не меняет. 8 MiB выбран для checkpoint раз в ~64 s, а не для fake speedup.
- Direct remote import быстрее и остаётся first choice для стабильных прямых HTTP URLs. Rutube API этой записи отдаёт только HLS, прямого progressive media URL нет.
- Pull через защищённый VPS/WebDAV измерен на `2.34 MiB/s` и технически обходит медленный PUT, но для Rutube требует отдельного short-lived relay lifecycle с сохранением pause/cancel/recovery; автоматически не включён вслепую.
- VK pull-relay не даёт достоверно разделить Source Speed и Yandex Upload Speed в одном demand-driven stream, поэтому UI не показывает выдуманные значения. Yandex remote import также не сообщает byte progress.
- Direct remote import сохраняет crash-window между ответом Yandex и записью operation URL; backup/retention SQLite/shared runtime также остаются будущей эксплуатационной задачей.
- Torrent hash checkpoint зависит от pinned `hash-wasm 4.12.0`. Обновлять библиотеку во время активного hash-pass можно только после проверки совместимости состояния; жёсткий `SIGKILL` может потерять максимум данные после последнего 4-МиБ checkpoint.
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
