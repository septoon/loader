# Current state

Production release `c6fe2c8` активен на `https://loader.lumastack.ru`. PM2 `loader` и `loader-vlc` используют один release и shared runtime, zero restarts. Public health: storage configured, torrent available, active transfers `0`.

Rutube и torrent больше не используют один многочасовой PUT. Source читается в bounded RAM-buffer максимум 8 MiB, затем отправляется отдельным Yandex `Content-Range`; каждый `202/201` сохраняет durable offset. Полного staging на VPS нет.

UI/API показывают раздельные Source Speed, Yandex Upload Speed и Bottleneck. Progress/ETA используют только подтверждённые Yandex bytes. Технические поля сохраняют buffer fill, последний PUT time и суммарный write wait.

Read-only медиатека доступна через HTTPS WebDAV `/vlc/` с отдельной Basic-auth учётной записью из ignored `runtime/secrets/vlc-sftp.env`. `PROPFIND`, `GET`, `HEAD` и byte ranges работают; writes/traversal/depth infinity запрещены. SFTP bridge также работает локально на 2022, но внешний порт блокирует UFW, поэтому клиентский путь — WebDAV 443.

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

- `npm test`: 27/27; server/web typecheck and production build passed.
- Public health, current release, PM2 zero-restart, WebDAV `207/206` and final media bytes verified.
- Synthetic media удалён recoverably в Yandex Trash; remote pull test destination отсутствует.
- На VPS оставлены только current `c6fe2c8` и rollback `6330399`; diagnostics удалены, свободно `1.8 GiB`.

# Known limits

- Yandex upload endpoint фактически ограничивает этот контур примерно `126–128 KiB/s`; изменение chunk size с 8 до 32 MiB скорость не меняет. 8 MiB выбран для checkpoint раз в ~64 s, а не для fake speedup.
- Direct remote import быстрее и остаётся first choice для стабильных прямых HTTP URLs. Rutube API этой записи отдаёт только HLS, прямого progressive media URL нет.
- Pull через защищённый VPS/WebDAV измерен на `2.34 MiB/s` и технически обходит медленный PUT, но для Rutube требует отдельного short-lived relay lifecycle с сохранением pause/cancel/recovery; автоматически не включён вслепую.
- Direct remote import сохраняет crash-window между ответом Yandex и записью operation URL; backup/retention SQLite/shared runtime также остаются будущей эксплуатационной задачей.
- `npm audit --omit=dev` показывает четыре high findings в pin `webtorrent@3.0.21 -> ip@2.0.1`; reachability ограничена tracker client path, automatic force-fix запрещён.

# Relevant files

- `src/server/rutube.ts`
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
