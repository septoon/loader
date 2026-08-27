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

При переходе от полной stream-selection к bounded read-window сначала устанавливается новое окно и только затем снимается полный диапазон. Это сохраняет непрерывное состояние `interested` для подключённых пиров и не обрывает раздачу на первом незаполненном участке cache.

Реализация использует private WebTorrent API `_markUnverified`, `_deselect` и `_select`; версия `3.0.21` зафиксирована. Обновлять её можно только после повторного bounded contract test или перехода на поддерживаемый extension point.

Если активный reader 30 секунд не получает следующую piece, worker повторно подключает до 50 ранее обнаруженных адресов через публичные `removePeer()`/`addPeer()`, затем вызывает публичный `bittorrent-tracker` client `update()` через discovery WebTorrent. Это сокращает 15-минутное штатное ожидание повторного announce после исчерпания reconnect-попыток; адреса не сохраняются и не выводятся в лог, общий inactivity timeout остаётся защитой от раздачи без доступных пиров.

## D-004 — Yandex resume использует server-authoritative HEAD offset

**Статус:** принято и подтверждено реальным API.

Основной uploader — один непрерывный PUT. После неоднозначного обрыва нельзя доверять local progress и нельзя повторять последний диапазон: это даёт `412`.

Worker poll-ит `HEAD` на тот же upload URL с полными `Etag` (MD5), `Sha256` и `Size`, ждёт стабилизации `Content-Length`, затем отправляет остаток с `Content-Range: bytes offset-(size-1)/size`. 128 MiB forced-disconnect test завершился с корректным size/MD5 и без staging.

Upload URL, source offset, hashes и job state должны храниться как чувствительный checkpoint. Временный URL не выводится в UI/logs.

## D-005 — Целостность проверяется после transfer

**Статус:** принято.

Loader сверяет удалённые `size` и `md5`, если их возвращает Yandex, и ведёт локальные MD5/SHA-256 во время чтения. Задача не становится completed до проверки metadata и конечного состояния операции. Для remote import без source checksum минимум — operation `success`, ожидаемый size и наличие MD5 у Yandex.

## D-006 — Транскодирование сейчас исключено

**Статус:** принято.

Loader транспортирует исходный файл. Video-page source на первом этапе допустим только при наличии прямого progressive media URL без крупного merge/staging.

## D-007 — VLC получает временную ссылку Yandex напрямую

**Статус:** архитектурный seam, реализация позже.

Storage layer должна уметь запрашивать краткоживущую download URL. Предпочтительный data path playback: `Yandex Disk -> VLC`; Loader proxy разрешён только как fallback. Будущий раздел `Library` читает `/Media/Movies` и `/Media/TV`, но не входит в текущий этап.

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

Direct URL использует Yandex remote import. Magnet и `.torrent` создают executable job: metadata -> safe media selection -> bounded hash-pass -> continuous Yandex PUT -> HEAD resume -> metadata verification. Multi-file state и upload URL сохраняются per-file в SQLite.

Активная remote-import operation не получает фиктивные pause/cancel semantics. Эти действия доступны только до запуска либо после retryable failure. UI показывает фактическое ограничение.

## D-012 — UI русскоязычный и отражает только фактическое состояние

**Статус:** принято и реализовано.

Исходный layout сохранён: sidebar, source composer, status tabs, table/list и detail panel. Обновление не добавляет отдельные dashboard/library sections. UI не показывает fake progress для remote import, не возвращает source query клиенту и не выводит operation/upload URL. Desktop/mobile используют один React component model и реальные API/SSE snapshots.
