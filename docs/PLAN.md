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
- [ ] Выпустить production hotfix torrent cache после подтверждения пользователя:
  - [x] Не снимать selection активного read-window при заполнении bounded cache.
  - [x] Показывать фактический прогресс и скорость hash-pass.
  - [x] Завершать задачу понятной ошибкой после тайм-аута отсутствия torrent data.
  - [x] Не отправлять `Content-Type: application/json` у пустых pause/cancel запросов.
  - [ ] Commit/push/deploy и проверка текущей пользовательской задачи на production.
- [ ] После отдельного согласования добавить единый read-only доступ к `/Media` для VLC; основной кандидат для текущих стабильных клиентов — SFTP bridge к Yandex Disk без дискового staging на VPS.

## Критерий выбора транспорта

1. Минимум байтов и диска на VPS.
2. Подтверждённое восстановление после сетевого сбоя/рестарта.
3. Проверяемая целостность итогового файла.
4. Соответствие официальному Yandex API и тарифным лимитам.
5. Предсказуемый backpressure и ограниченный cache.

## Подтверждённая транспортная архитектура

- Direct HTTP: remote import Yandex Disk, затем проверка operation и metadata; media bytes не проходят через VPS.
- Streaming fallback: continuous PUT; после ошибки `HEAD` с full MD5/SHA-256/size, стабилизация server offset, затем upload остатка.
- Torrent: WebTorrent sequential stream -> bounded cache -> continuous Yandex uploader; при сбое закончить hash-pass и повторно читать source с server offset.
- Поддерживаемая video page: получить прямой progressive URL без транскодирования/merge и передать его в remote import либо bounded stream.
- Если source нельзя повторно прочитать, full hashes неизвестны или upload URL потерян, job честно переходит в Retry; полный staging на VPS не использовать скрытно.

## После транспортной валидации

- Персистентная очередь задач и восстановление после рестарта.
- Один большой transfer по умолчанию; лимиты должны быть конфигурируемыми.
- Авторизация веб-интерфейса, SSRF/path/file-name validation, rate limits и безопасная работа с subprocess.
- Progress, pause/cancel/retry, понятные ошибки и диагностические логи без секретов.
- PWA с адаптивным compact UI.
- Storage seam для будущих `Library` и `Open in VLC`, без реализации Library на текущем этапе.
