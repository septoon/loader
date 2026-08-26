# Loader — контекст проекта

## Назначение

Loader — персональный веб-сервис, который принимает прямые URL, поддерживаемые страницы с видео, magnet-ссылки и `.torrent`, продолжает работу после закрытия браузера и сохраняет итоговый файл в Yandex Disk.

Основные каталоги:

- `/Media/Movies`
- `/Media/TV`
- `/Media/Unsorted` — только если тип не определён или выбран явно

Целевой публичный адрес в будущем: `https://loader.lumastack.ru`.

## Жёсткое инфраструктурное ограничение

На VPS доступно примерно 3 GB диска. VPS должен хранить состояние задач, небольшие метаданные и строго ограниченный cache, но не полный медиофайл. Архитектура обязана сохранять backpressure по всей цепочке и заранее останавливать задачу, если резерв свободного места нарушен.

Целевой путь данных:

```text
Источник -> ограниченный транспорт Loader -> Yandex Disk
```

Для прямого HTTP URL предпочтителен ещё более короткий официальный путь:

```text
Источник -> remote import Yandex Disk
```

## Текущий архитектурный контур

- Runtime PoC: Node.js 22, WebTorrent `3.0.21`.
- Torrent: последовательное чтение, bounded piece-cache на диске, ограниченное число pending pieces и backpressure.
- HTTP: подтверждённый официальный remote import Yandex Disk — основной transport; streaming upload — fallback.
- Yandex streaming: один continuous PUT; после сбоя server offset получается через `HEAD` с full MD5/SHA-256/size, затем отправляется остаток через `Content-Range`.
- Состояние задач в production должно быть персистентным и восстанавливаться после рестарта процесса/VPS.
- Storage integration должна предоставлять отдельные операции upload/import, проверку результата и получение краткоживущей download URL.

Production stack: Node.js 22 + TypeScript, Fastify API/SSE, React/Vite PWA, SQLite WAL, concurrency одного большого transfer по умолчанию.

## Yandex Disk

Нужны минимальные scopes:

- `cloud_api:disk.write`
- `cloud_api:disk.read`
- `cloud_api:disk.info`

App-folder scope не подходит: Loader должен работать с `/Media/Movies` и `/Media/TV`.

Реальный 128 MiB test подтвердил resume на том же upload URL без staging. Local progress не является checkpoint: после отдачи 8,388,608 bytes Yandex подтвердил 8,384,180 bytes. Истина получается через `HEAD`; наивный replay возвращает `412`.

Resume HEAD требует заранее известные full MD5, SHA-256 и size. Для torrent это означает hash-pass и возможное повторное чтение suffix после сбоя.

Также до старта большой задачи нужно проверять доступную квоту и лимит одного файла для конкретного тарифа Yandex Disk.

## Будущий playback через VLC

Предпочтительная схема:

```text
Loader -> Yandex Disk API -> временная download URL -> VLC
                         затем Yandex Disk -> VLC
```

Loader не должен проксировать видеопоток без необходимости. VPS proxy допускается только как fallback. Транскодирование сейчас исключено из scope.

Позже может появиться раздел `Library` для `/Media/Movies` и `/Media/TV` с действием `Open in VLC`. Текущая storage abstraction не должна блокировать это расширение, но Library не входит в ближайший этап.

## Текущий этап

Torrent transport, Yandex remote import, continuous streaming и forced-disconnect resume подтверждены. Текущий этап — production backend/frontend и интеграция torrent stream с Yandex uploader. VPS ещё не аудирован и deployment не начинался.
