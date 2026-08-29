# Принятые решения

## D-001 — VPS не хранит полный медиофайл

**Статус:** принято.

VPS используется как оркестратор и ограниченный транспорт. Полный staging запрещён как основной и скрытый fallback из-за примерно 3 GB свободного диска.

## D-002 — Прямой Yandex remote import имеет приоритет для HTTP

**Статус:** принято и подтверждено реальным API.

Если источник доступен Yandex по стабильному прямому URL, используется официальный remote import. Реальный 8 MiB test завершился за 2.29 s при 0 media bytes через Loader. Loader poll-ит operation и проверяет удалённые metadata. При ошибке Yandex import не повторяется автоматически без идемпотентной job policy.

## D-003 — Torrent использует sequential read и bounded piece-cache

**Статус:** реализовано; bounded contract подтверждён локальным PoC.

Cache ограничивается по bytes, резерву свободного диска и числу pending pieces. Downstream backpressure управляет выбором torrent pieces. Полный torrent не сохраняется на VPS.

Сразу после создания file iterator полная stream-selection заменяется bounded read-window из текущей piece и трёх следующих. Окно двигается вместе с reader и не раскрывается обратно до конца iterator. При замене сначала устанавливается новое окно и только затем снимается полный диапазон: состояние `interested` для подключённых пиров остаётся непрерывным, а дальние pieces не могут заполнить cache раньше reader.

Реализация использует private WebTorrent API `_markUnverified`, `_deselect` и `_select`; версия `3.0.21` зафиксирована. Обновлять её можно только после повторного bounded contract test или перехода на поддерживаемый extension point.

Если активный reader 30 секунд не получает следующую piece, worker повторно подключает до 50 ранее обнаруженных адресов через публичные `removePeer()`/`addPeer()`; адреса с ранее успешным `wire` имеют приоритет. Затем вызывается публичный `bittorrent-tracker` client `update()` через discovery WebTorrent. Это сокращает 15-минутное штатное ожидание повторного announce после исчерпания reconnect-попыток; адреса не сохраняются и не выводятся в лог, общий inactivity timeout остаётся защитой от раздачи без доступных пиров.

## D-004 — Yandex resume использует server-authoritative HEAD offset

**Статус:** принято и подтверждено реальным API.

Основной uploader передаёт последовательные диапазоны по 8 МиБ. Каждый `202/201` становится durable checkpoint; локальный progress меняется только после ответа Yandex. Один непрерывный PUT исключён после production-инцидента: соединение трижды оборвалось через 78–121 минут, а неподтверждённый offset откатился к нулю.

Worker poll-ит `HEAD` на тот же upload URL с полными `Etag` (MD5), `Sha256` и `Size`, ждёт стабилизации `Content-Length`, затем продолжает с точного server offset. Реальный API test `3 × 8 МиБ` вернул `202/202/201`, итоговый size/MD5 совпал. Перед каждым PUT source независимо заполняет bounded RAM-buffer максимум 8 МиБ; полного staging нет.

Upload URL, source offset, hashes и job state должны храниться как чувствительный checkpoint. Временный URL не выводится в UI/logs.

## D-005 — Целостность проверяется после transfer

**Статус:** принято.

Loader сверяет удалённые `size` и `md5`, если их возвращает Yandex, и ведёт локальные MD5/SHA-256 во время чтения. Задача не становится completed до проверки metadata и конечного состояния операции. Для remote import без source checksum минимум — operation `success`, ожидаемый size и наличие MD5 у Yandex.

## D-006 — Транскодирование сейчас исключено

**Статус:** принято.

Loader транспортирует исходный файл. Video-page source на первом этапе допустим только при наличии прямого progressive media URL без крупного merge/staging.

## D-007 — VLC получает каталог `/Media` через read-only WebDAV

**Статус:** реализовано; SFTP оставлен дополнительным transport.

Единый production URL `/vlc/` публикует `/Media` через HTTPS WebDAV с отдельной Basic-auth учётной записью. `PROPFIND` перечисляет папки, `GET`/`HEAD` поддерживают byte ranges. Loader получает краткоживущую download URL официальным Disk API, строго валидирует Yandex host и передаёт response stream без дискового медиакеша. Запись, удаление, переименование и WebDAV depth infinity запрещены.

Отдельный SFTP-процесс реализует тот же read-only root и bounded range reads: максимум 8 подключений, 16 одновременных чтений по 256 КиБ на session. Он проверен локально, но UFW с `DEFAULT_INPUT_POLICY=DROP` не пропускает внешний TCP 2022 без root-доступа. Поэтому общий путь для устройств — WebDAV на уже открытом TLS 443. Данные playback проходят через VPS; это fallback к будущему прямому открытию временной Yandex URL, но полного staging нет.

## D-008 — Production stack: Node/TypeScript, Fastify, React PWA, SQLite

**Статус:** принято после transport test.

Backend и worker используют Node.js 22 + TypeScript. Fastify предоставляет authenticated API и SSE. React/Vite реализует адаптивную PWA. SQLite в WAL mode хранит jobs, events, sessions и checkpoint metadata. Один worker обрабатывает один большой job по умолчанию; API и worker разделены логически, а production topology уточняется после VPS audit.

## D-009 — Audit finding WebTorrent нельзя игнорировать в production

**Статус:** контролируемый supply-chain риск.

Текущая последняя версия WebTorrent транзитивно использует `ip@2.0.1`, для которого опубликован high-severity SSRF advisory. Reachability audit показал: `ip` используется в UDP parser tracker server, Loader использует tracker client, а уязвимый `isPublic` path не вызывается. Автоматический downgrade не применяется. Torrent worker изолируется, tracker server не запускается, зависимость фиксируется и повторно проверяется при обновлениях.

## D-010 — Hash strategy для torrent resume

**Статус:** принято с явным trade-off.

Yandex resume HEAD требует full MD5/SHA-256/size, а torrent metadata обычно не содержит per-file MD5/SHA-256. Production worker сначала выполняет отдельный bounded hash-pass и сохраняет hashes, затем повторно читает source для upload. Это удваивает source read в штатном случае, но устраняет несериализуемое hash-state окно и позволяет после process crash сразу запросить authoritative offset. Media на VPS полностью не staging-ится.

## D-011 — Production очередь поддерживает direct URL и BitTorrent

**Статус:** реализовано, live torrent/restart E2E ещё нужен.

Direct URL использует Yandex remote import. Magnet и `.torrent` создают executable job: metadata -> safe media selection -> bounded hash-pass -> 8-МиБ Yandex ranges -> HEAD resume -> metadata verification. Multi-file state и upload URL сохраняются per-file в SQLite.

Активная remote-import operation не получает фиктивные pause/cancel semantics. Эти действия доступны только до запуска либо после retryable failure. UI показывает фактическое ограничение.

## D-012 — UI русскоязычный и отражает только фактическое состояние

**Статус:** принято и реализовано.

Исходный layout сохранён: sidebar, source composer, status tabs, table/list и detail panel. Обновление не добавляет отдельные dashboard/library sections. UI не показывает fake progress для remote import, не возвращает source query клиенту и не выводит operation/upload URL. Desktop/mobile используют один React component model и реальные API/SSE snapshots.

## D-013 — Rutube не обрабатывается как direct URL

**Статус:** реализовано и проверено на пользовательской ссылке.

HTML-страница Rutube не передаётся в Yandex remote import. Resolver извлекает video id, обращается к официальному `api/play/options/{id}/`, выбирает HLS не выше 720p и принимает только конечный незашифрованный MPEG-TS playlist без discontinuity, byte-range и fMP4 map.

Worker сначала последовательно вычисляет MD5/SHA-256 и размеры сегментов, затем читает и передаёт 8-МиБ диапазоны. В SQLite сохраняется компактный checkpoint размеров, поэтому после рестарта точный Yandex server offset сопоставляется сегменту без повторного HEAD-сканирования 1924 объектов. В каждый момент в памяти находится не более одного bounded range; полного файла на VPS нет. Pause/cancel/resume используют тот же abort-aware job lifecycle, что torrent.

## D-014 — Source и Yandex throughput измеряются раздельно

**Статус:** реализовано после production-профилирования.

Старый `speed` измерял скорость demand-driven source iterator под downstream backpressure и смешивал источник с upload. Он не мог достоверно назвать узкое место.

Production-замер пользовательского Rutube показал 39.8 МиБ/с на 72 HLS GET и 126–128 КиБ/с на Yandex PUT. Для 32 МиБ Yandex TCP receive window ограничивал socket 98.8% времени; из 128 writes по 256 КиБ два блокировались более секунды, максимум 31.8 с. В range test тело каждого 8-МиБ PUT уходило за 0.05–0.20 с, а ответ Yandex ожидался 63.9–66.1 с. Искусственного throttling в Loader нет.

Теперь source сначала заполняет отдельный 8-МиБ RAM-buffer, затем измеряется полный Yandex request до `202/201`. SQLite/API/UI хранят и показывают `Source Speed`, `Yandex Upload Speed`, определённый по их сравнению `Bottleneck`, заполнение буфера, длительность последнего PUT и суммарный write wait. Progress/ETA используют только подтверждённые Yandex bytes и effective upload speed.

## D-015 — VK Видео использует защищённый pull-relay

**Статус:** реализовано и проверено на production.

Страница `vkvideo.ru` не является прямым файлом и не передаётся в Yandex remote import. Pinned standalone `yt-dlp 2026.07.04` вызывается через `execFile` без shell/cookies/config, выбирает progressive MP4 максимум 1080p и возвращает название, длительность, размер, одноразовый media URL и необходимые заголовки. URL принимается только с HTTPS-доменов VK CDN и публичных IP; query и адрес потока не сохраняются в SQLite и не выводятся в API/logs.

Прямой import извлечённого URL реально завершился `failed`: signed URL содержит `srcIp`, а запрос без требуемых заголовков возвращает ошибку. Поэтому Yandex remote import получает job-scoped URL Loader с HMAC-derived Basic auth. Relay заново извлекает короткоживущий URL на VPS, проксирует только MP4/range с backpressure и `X-Accel-Buffering: no`, не пишет медиабайты на диск и не передаёт Authorization источнику.

Активный VK import имеет те же ограничения pause/cancel, что обычный Yandex remote import. Source/Yandex скорости в UI помечаются как не измеряемые: при pull-relay один demand-driven поток не позволяет достоверно разделить source и downstream throughput.

## D-016 — Torrent использует TCP и персистентный hash-pass

**Статус:** реализовано и проверено на production.

`utp-native@2.5.3` дважды завершил весь Loader необработанным `UTP_ECONNRESET` при штатном peer disconnect. Torrent client использует поддержанный WebTorrent option `utp: false`; TCP, tracker discovery, manual peer reconnect и bounded cache остаются активны. Обработка peer error не должна иметь возможность уронить API/SSE процесс.

Пауза во время hash-pass удерживает WebTorrent client, bounded cache и hash objects в памяти. Для source timeout, process restart и deploy используется pinned `hash-wasm 4.12.0`: `save()`/`load()` сериализуют совместимые MD5/SHA-256 states. SQLite checkpoint содержит версию формата, ожидаемый размер, offset и два base64url state и обновляется каждые 4 МиБ или перед контролируемой остановкой. Возобновление начинает torrent iterator с этого offset; полный медиофайл на VPS не сохраняется.

Размер, формат и встроенная сигнатура WASM state проверяются до использования. Несовместимый или повреждённый checkpoint отбрасывается. Обновление `hash-wasm` требует проверки совместимости либо завершения активных hash-pass. При жёстком `SIGKILL` возможно потерять только интервал после последней 4-МиБ отметки, а не весь прогресс. После готовых digests upload resume использует server-authoritative Yandex checkpoint.

Отмена и удаление разделены. Старый cancel endpoint остаётся совместимым, новый remove endpoint удаляет только запись Loader и её служебные данные. Уже сохранённый media-файл на Яндекс Диске не удаляется автоматически.
