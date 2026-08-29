# План Loader

## Текущий порядок работ

- [x] Проверить torrent pipeline с bounded piece-cache и backpressure на локальном mock upload.
- [x] Зафиксировать результаты PoC и ограничения проекта в документации.
- [x] Создать OAuth-приложение Yandex Disk с минимальными scopes и безопасно сохранить личный token вне Git.
- [x] Проверить API identity/quota, создание служебного каталога и небольшой реальный upload.
- [x] Проверить большой streaming upload без полного staging.
- [x] Принудительно оборвать соединение и подтвердить resume через `HEAD` server offset и `Content-Range`.
- [x] Сверить удалённые `size` и `md5`, локально вычислить SHA-256.
- [x] Проверить восстановление torrent upload после полного рестарта worker с persistent checkpoint.
- [x] Проверить официальный remote import по прямому HTTP URL и polling операции.
- [x] По результатам тестов выбрать окончательную транспортную архитектуру.
- [ ] Завершить production jobs, API, PWA UI, безопасность и эксплуатационный контур:
  - [x] Fastify API, signed HttpOnly session, rate limit и SSE snapshot.
  - [x] SQLite WAL jobs/events и восстановление direct URL remote-import по сохранённой operation URL.
  - [x] Адаптивный русскоязычный React/Vite PWA UI для очереди и direct URL.
  - [x] SSRF/path/file-name validation и скрытие query source из UI/logs.
  - [x] Подключить magnet/`.torrent` к bounded WebTorrent source и Yandex streaming uploader.
  - [x] Проверить restart recovery реальной незавершённой torrent-операции.
  - [ ] Закрыть crash-window direct remote import до записи operation URL.
  - [x] Добавить release/shared-runtime topology, отдельный Node 22 и PM2 supervision после VPS audit.
  - [ ] Добавить backup/retention и расширенную observability.
- [x] Выполнить deploy и public health/auth/static/SSE smoke после разрешения пользователя.
- [x] Провести legal live torrent E2E с kill/restart recovery на отдельном безопасном target.
- [x] Сохранять MD5/SHA-256 state torrent hash-pass в SQLite и продолжать проверку после source timeout, PM2 restart и deploy без отката к нулю.
- [x] Убрать двойное чтение torrent: передавать source на Яндекс в один проход, синхронизируя hash state с подтверждённым remote offset и не сохраняя полный файл на VPS.
- [x] Выпустить production hotfix torrent cache после подтверждения пользователя:
  - [x] Не снимать selection активного read-window при заполнении bounded cache.
  - [x] Показывать фактический прогресс и скорость hash-pass.
  - [x] Завершать задачу понятной ошибкой после тайм-аута отсутствия torrent data.
  - [x] Не отправлять `Content-Type: application/json` у пустых pause/cancel запросов.
  - [x] Commit/push/deploy, live bounded progress и реальные pause/cancel на production.
- [x] Добавить отдельный transport для страниц Rutube: официальный play-options API, максимум 720p, последовательный HLS hash/upload, persistent segment checkpoint и resume без staging.
- [x] Добавить единый read-only доступ к `/Media` для VLC через HTTPS WebDAV с range-stream из официального Yandex Disk API; SFTP bridge также запущен локально, но внешний TCP 2022 требует отдельного root-правила UFW.
- [x] Разделить source/Yandex throughput: production profile, 8-МиБ bounded RAM-buffer, range checkpoint, write/backpressure telemetry и отдельные Source/Yandex/Bottleneck показатели в UI.
- [x] Добавить VK Видео как отдельный page-source: настоящее название/размер, pinned metadata resolver и защищённый pull-relay для Яндекс Диска без staging на VPS.
- [x] Упростить мобильный UI: убрать дублирующую нижнюю навигацию, сократить composer и сворачивать технические детали задач по умолчанию.

## Критерий выбора транспорта

1. Минимум байтов и диска на VPS.
2. Подтверждённое восстановление после сетевого сбоя/рестарта.
3. Проверяемая целостность итогового файла.
4. Соответствие официальному Yandex API и тарифным лимитам.
5. Предсказуемый backpressure и ограниченный cache.

## Подтверждённая транспортная архитектура

- Direct HTTP: remote import Yandex Disk, затем проверка operation и metadata; media bytes не проходят через VPS.
- Streaming fallback: последовательные 8-МиБ `Content-Range`; после ошибки `HEAD` с `Size` стабилизирует server offset, затем transport продолжает с точной подтверждённой отметки.
- Torrent: WebTorrent sequential stream -> bounded piece-cache -> bounded 8-МиБ RAM-buffer -> Yandex range uploader в один проход; MD5/SHA-256 state сохраняется вместе с подтверждённым server offset, а crash-window догоняется bounded reread source без full staging.
- Rutube: официальный play-options API -> максимум 720p HLS/MPEG-TS -> bounded hash-pass -> 8-МиБ Yandex ranges с точным resume по segment checkpoint.
- VK Видео: pinned `yt-dlp` извлекает progressive MP4 максимум 1080p; Яндекс Диск забирает его через job-scoped Basic-auth relay Loader, потому что signed media URL привязан к IP и требует заголовки клиента. Relay не staging-ит файл и поддерживает range.
- Если source нельзя повторно прочитать, full hashes неизвестны или upload URL потерян, job честно переходит в Retry; полный staging на VPS не использовать скрытно.

## После транспортной валидации

- Персистентная очередь задач и восстановление после рестарта.
- Один большой transfer по умолчанию; лимиты должны быть конфигурируемыми.
- Авторизация веб-интерфейса, SSRF/path/file-name validation, rate limits и безопасная работа с subprocess.
- Progress, pause/cancel/retry, понятные ошибки и диагностические логи без секретов.
- PWA с адаптивным compact UI.
- Read-only медиатека `/Media` для VLC через WebDAV/HTTPS; временная Yandex download URL валидируется и не выводится клиенту или в логи.
