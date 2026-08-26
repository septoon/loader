import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const API_ROOT = 'https://cloud-api.yandex.net/v1/disk';
const MIB = 1024 * 1024;
const PATTERN_SIZE = MIB;
const pattern = Buffer.allocUnsafe(PATTERN_SIZE);
for (let index = 0; index < pattern.length; index += 1) {
  pattern[index] = (index * 31 + (index >>> 8) * 17 + 0x5a) & 0xff;
}
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tokenPath = path.join(projectRoot, 'runtime', 'secrets', 'yandex-token');
const mode = process.argv[2] ?? 'info';
const supportedModes = new Set(['info', 'single', 'range', 'resume', 'remote', 'verify']);
const baselineRssBytes = process.memoryUsage().rss;
let peakRssBytes = baselineRssBytes;
const rssSampler = setInterval(() => {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
}, 100);
rssSampler.unref();

if (!supportedModes.has(mode)) {
  console.error('Usage: npm run poc:yandex -- <info|single|range|resume|remote|verify>');
  process.exit(2);
}

let token;

try {
  token = await loadToken();
  const disk = await apiRequest('/', { fields: 'total_space,used_space,trash_size' });
  const freeBytes = disk.total_space - disk.used_space;

  console.log(JSON.stringify({
    probe: 'disk-info',
    totalBytes: disk.total_space,
    usedBytes: disk.used_space,
    trashBytes: disk.trash_size,
    freeBytes,
  }, null, 2));

  if (mode === 'info') {
    process.exit(0);
  }

  if (mode === 'verify') {
    const remotePath = normalizeDiskPath(process.env.YANDEX_POC_PATH ?? '');
    const metadata = await apiRequest('/resources', {
      path: remotePath,
      fields: 'path,type,size,md5',
    });
    const expectedMiB = process.env.YANDEX_POC_MIB === undefined
      ? null
      : parsePositiveInteger('YANDEX_POC_MIB', 1);
    const expected = expectedMiB === null ? null : computeDigests(expectedMiB * MIB);
    const verified = metadata.type === 'file'
      && (expected === null || (metadata.size === expectedMiB * MIB && metadata.md5 === expected.md5));

    console.log(JSON.stringify({
      result: verified ? 'passed' : 'failed',
      remotePath,
      remoteType: metadata.type,
      remoteSize: metadata.size,
      remoteMd5: metadata.md5,
      expectedMd5: expected?.md5 ?? null,
      expectedSha256: expected?.sha256 ?? null,
    }, null, 2));

    if (!verified) {
      process.exitCode = 1;
    }
    process.exit();
  }

  const totalMiB = parsePositiveInteger('YANDEX_POC_MIB', ['single', 'remote'].includes(mode) ? 8 : 24);
  const totalBytes = totalMiB * MIB;

  if (!Number.isSafeInteger(totalBytes)) {
    throw new Error('YANDEX_POC_MIB is too large for an exact byte count');
  }

  if (freeBytes < totalBytes + 32 * MIB) {
    throw new Error(`Not enough Yandex Disk quota for ${totalMiB} MiB probe plus safety reserve`);
  }

  const folder = normalizeDiskPath(process.env.YANDEX_POC_FOLDER ?? '/Loader-PoC');
  await ensureFolder(folder);

  const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14);
  const remotePath = `${folder}/${mode}-${totalMiB}MiB-${stamp}.bin`;

  if (mode === 'remote') {
    const sourceUrl = validateRemoteSource(
      process.env.YANDEX_POC_SOURCE_URL ?? `https://speed.cloudflare.com/__down?bytes=${totalBytes}`,
    );
    const startedAt = process.hrtime.bigint();
    const operation = await apiRequest('/resources/upload', {
      url: sourceUrl.href,
      path: remotePath,
      disable_redirects: false,
    }, { method: 'POST' });

    await waitForOperation(operation.href);
    const metadata = await waitForMetadata(remotePath, totalBytes);
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);

    console.log(JSON.stringify({
      result: metadata.type === 'file' && metadata.size === totalBytes ? 'passed' : 'failed',
      probe: 'remote-import',
      sourceHost: sourceUrl.host,
      remotePath,
      remoteSize: metadata.size,
      remoteMd5: metadata.md5,
      loaderTransferredBytes: 0,
      stagingBytes: 0,
      durationSeconds: Number(durationSeconds.toFixed(2)),
      baselineRssBytes,
      peakRssBytes,
      rssDeltaBytes: peakRssBytes - baselineRssBytes,
    }, null, 2));
    process.exit(0);
  }

  const expected = computeDigests(totalBytes);
  const upload = await requestUploadLink(remotePath);

  console.log(JSON.stringify({
    probe: mode,
    remotePath,
    totalBytes,
    stagingBytes: 0,
    uploaderHost: new URL(upload.href).host,
  }, null, 2));

  const transferStartedAt = process.hrtime.bigint();

  if (mode === 'single') {
    const response = await putGeneratedRange(upload.href, 0, totalBytes, totalBytes, false);
    requireUploadStatus(response, { final: true });
    console.log(JSON.stringify({ step: 'single-put', status: response.status }, null, 2));
  } else {
    const partMiB = parsePositiveInteger('YANDEX_POC_PART_MIB', 8);
    const partBytes = partMiB * MIB;
    let offset = 0;
    let part = 0;

    if (mode === 'resume') {
      const requestedAbortMiB = parsePositiveInteger('YANDEX_POC_ABORT_MIB', 4);
      const abortAfterBytes = Math.min(requestedAbortMiB * MIB, totalBytes - 1);
      let interrupted = false;

      try {
        await putGeneratedRange(upload.href, 0, totalBytes, totalBytes, false, abortAfterBytes);
      } catch {
        interrupted = true;
      }

      if (!interrupted) {
        throw new Error('Injected upload disconnect did not interrupt the first range');
      }

      console.log(JSON.stringify({
        step: 'injected-disconnect',
        rangeStart: 0,
        declaredRangeEnd: totalBytes - 1,
        disconnectedAfterBytes: abortAfterBytes,
        nextAction: 'query-server-offset-with-head',
      }, null, 2));

      const { uploadedBytes, samples } = await waitForStableUploadedSize(upload.href, expected, totalBytes);

      console.log(JSON.stringify({
        step: 'head-upload-offset',
        uploadedBytes,
        samples,
      }, null, 2));

      if (uploadedBytes < 0 || uploadedBytes >= totalBytes) {
        throw new Error(`Unexpected uploaded offset after disconnect: ${uploadedBytes}`);
      }

      const continuation = await putGeneratedRange(
        upload.href,
        uploadedBytes,
        totalBytes - uploadedBytes,
        totalBytes,
        uploadedBytes > 0,
      );
      requireUploadStatus(continuation, { final: true });

      console.log(JSON.stringify({
        step: 'continue-after-disconnect',
        start: uploadedBytes,
        end: totalBytes - 1,
        status: continuation.status,
      }, null, 2));

      offset = totalBytes;
    }

    while (offset < totalBytes) {
      const length = Math.min(partBytes, totalBytes - offset);
      const final = offset + length === totalBytes;
      const response = await putGeneratedRange(upload.href, offset, length, totalBytes, true);
      requireUploadStatus(response, { final });

      console.log(JSON.stringify({
        step: 'range-put',
        part,
        start: offset,
        end: offset + length - 1,
        status: response.status,
        responseRange: response.headers.get('range') ?? response.headers.get('content-range') ?? null,
      }, null, 2));

      offset += length;
      part += 1;
    }
  }

  const metadata = await waitForMetadata(remotePath, totalBytes);
  const verified = metadata.size === totalBytes && metadata.md5 === expected.md5;
  const durationSeconds = Number(process.hrtime.bigint() - transferStartedAt) / 1e9;
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);

  console.log(JSON.stringify({
    result: verified ? 'passed' : 'failed',
    remotePath,
    remoteSize: metadata.size,
    remoteMd5: metadata.md5,
    expectedMd5: expected.md5,
    expectedSha256: expected.sha256,
    durationSeconds: Number(durationSeconds.toFixed(2)),
    throughputMiBps: Number((totalMiB / durationSeconds).toFixed(3)),
    baselineRssBytes,
    peakRssBytes,
    rssDeltaBytes: peakRssBytes - baselineRssBytes,
    stagingBytes: 0,
    note: 'SHA-256 is computed locally over the deterministic source; Yandex metadata exposes MD5.',
  }, null, 2));

  if (!verified) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Yandex probe failed: ${error.message}`);
  process.exitCode = 1;
}

async function loadToken() {
  const environmentToken = process.env.YANDEX_DISK_TOKEN?.trim();
  if (environmentToken) {
    return environmentToken;
  }

  let tokenFile;
  try {
    tokenFile = await stat(tokenPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('Yandex token is missing. Run: npm run yandex:store-token');
    }
    throw error;
  }

  if ((tokenFile.mode & 0o077) !== 0) {
    throw new Error('runtime/secrets/yandex-token must not be readable by group or others (expected mode 0600)');
  }

  const value = (await readFile(tokenPath, 'utf8')).trim();
  if (value.length < 20 || /\s/.test(value)) {
    throw new Error('Stored Yandex token looks invalid');
  }
  return value;
}

async function apiRequest(resource, query = {}, options = {}) {
  const url = new URL(`${API_ROOT}${resource}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetchWithRetry(url, {
    method: options.method ?? 'GET',
    headers: { Authorization: `OAuth ${token}` },
  });

  const body = await readBody(response);
  if (!response.ok) {
    throw new Error(`Yandex API ${options.method ?? 'GET'} ${resource} failed with ${response.status}: ${safeBody(body)}`);
  }

  return body ? JSON.parse(body) : null;
}

async function ensureFolder(folder) {
  const response = await fetchWithRetry(new URL(`${API_ROOT}/resources?path=${encodeURIComponent(folder)}`), {
    method: 'PUT',
    headers: { Authorization: `OAuth ${token}` },
  }, new Set([201, 409]));

  if (response.status === 201) {
    console.log(JSON.stringify({ step: 'create-folder', path: folder, status: 201 }, null, 2));
    return;
  }

  const metadata = await apiRequest('/resources', { path: folder, fields: 'type,path' });
  if (metadata.type !== 'dir') {
    throw new Error(`${folder} exists but is not a directory`);
  }
}

async function requestUploadLink(remotePath) {
  return apiRequest('/resources/upload', {
    path: remotePath,
    overwrite: false,
    fields: 'href,method,templated,operation_id',
  });
}

async function putGeneratedRange(href, start, length, totalBytes, includeRange, abortAfterBytes = null) {
  const headers = {
    'Content-Length': String(length),
    'Content-Type': 'application/octet-stream',
  };

  if (includeRange) {
    headers['Content-Range'] = `bytes ${start}-${start + length - 1}/${totalBytes}`;
  }

  return fetch(href, {
    method: 'PUT',
    headers,
    body: generatedStream(start, length, abortAfterBytes),
    duplex: 'half',
    redirect: 'error',
    signal: AbortSignal.timeout(parsePositiveInteger('YANDEX_POC_TIMEOUT_MIN', 30) * 60 * 1000),
  });
}

async function getUploadedSize(href, expected, totalBytes) {
  const response = await fetch(href, {
    method: 'HEAD',
    headers: {
      Etag: expected.md5,
      Sha256: expected.sha256,
      Size: String(totalBytes),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });

  if (response.status !== 200) {
    throw new Error(`Yandex upload offset HEAD failed with ${response.status}`);
  }

  const uploadedBytes = Number(response.headers.get('content-length'));
  if (!Number.isSafeInteger(uploadedBytes) || uploadedBytes < 0) {
    throw new Error('Yandex upload offset HEAD returned an invalid Content-Length');
  }
  return uploadedBytes;
}

async function waitForStableUploadedSize(href, expected, totalBytes) {
  const deadline = Date.now() + 90_000;
  const samples = [];
  let stableCount = 0;
  let previous = null;

  while (Date.now() < deadline) {
    const uploadedBytes = await getUploadedSize(href, expected, totalBytes);
    samples.push(uploadedBytes);

    if (uploadedBytes === previous) {
      stableCount += 1;
    } else {
      stableCount = 1;
      previous = uploadedBytes;
    }

    if (stableCount >= 4) {
      return { uploadedBytes, samples };
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Yandex upload offset did not stabilize: ${samples.join(',')}`);
}

function requireUploadStatus(response, { final }) {
  const allowed = final ? new Set([201, 202]) : new Set([202]);
  if (allowed.has(response.status)) {
    return;
  }

  const reportedRange = response.headers.get('range') ?? response.headers.get('content-range');
  throw new Error(`Yandex uploader rejected ${final ? 'final' : 'intermediate'} range with ${response.status}${reportedRange ? ` (reported range: ${reportedRange})` : ''}`);
}

async function waitForMetadata(remotePath, expectedSize) {
  const deadline = Date.now() + 90_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const metadata = await apiRequest('/resources', {
        path: remotePath,
        fields: 'path,type,size,md5',
      });
      if (metadata.type === 'file' && metadata.size === expectedSize && metadata.md5) {
        return metadata;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }

  throw new Error(`Timed out waiting for uploaded metadata${lastError ? `: ${lastError.message}` : ''}`);
}

async function waitForOperation(href) {
  const operationUrl = new URL(href);
  if (operationUrl.protocol !== 'https:'
    || operationUrl.hostname !== 'cloud-api.yandex.net'
    || !operationUrl.pathname.startsWith('/v1/disk/operations')) {
    throw new Error('Yandex returned an unexpected operation URL');
  }

  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const response = await fetchWithRetry(operationUrl, {
      headers: { Authorization: `OAuth ${token}` },
    });
    const body = await readBody(response);
    if (!response.ok) {
      throw new Error(`Yandex operation status failed with ${response.status}: ${safeBody(body)}`);
    }

    const operation = JSON.parse(body);
    if (operation.status === 'success') {
      return;
    }
    if (operation.status === 'failed') {
      throw new Error(`Yandex remote import failed: ${safeBody(body)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error('Timed out waiting for Yandex remote import operation');
}

async function fetchWithRetry(url, options, acceptedStatuses = null) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok || acceptedStatuses?.has(response.status) || ![429, 500, 502, 503, 504].includes(response.status)) {
        return response;
      }
      lastError = new Error(`temporary HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** attempt)));
  }
  throw lastError;
}

function generatedStream(start, length, abortAfterBytes = null) {
  return Readable.from((async function* generate() {
    let offset = start;
    let remaining = length;
    let emitted = 0;
    while (remaining > 0) {
      const patternOffset = offset % PATTERN_SIZE;
      const untilAbort = abortAfterBytes === null ? remaining : abortAfterBytes - emitted;
      if (untilAbort <= 0) {
        throw new Error('Injected upload disconnect');
      }
      const take = Math.min(remaining, PATTERN_SIZE - patternOffset, untilAbort);
      yield pattern.subarray(patternOffset, patternOffset + take);
      offset += take;
      remaining -= take;
      emitted += take;
      if (abortAfterBytes !== null && emitted >= abortAfterBytes) {
        throw new Error('Injected upload disconnect');
      }
    }
  })());
}

function computeDigests(totalBytes) {
  const md5 = createHash('md5');
  const sha256 = createHash('sha256');
  let remaining = totalBytes;
  while (remaining > 0) {
    const take = Math.min(remaining, PATTERN_SIZE);
    const chunk = pattern.subarray(0, take);
    md5.update(chunk);
    sha256.update(chunk);
    remaining -= take;
  }
  return { md5: md5.digest('hex'), sha256: sha256.digest('hex') };
}

function normalizeDiskPath(value) {
  const normalized = value.replaceAll('\\', '/').replace(/\/{2,}/g, '/');
  if (!normalized.startsWith('/') || normalized.includes('/../') || normalized.endsWith('/..')) {
    throw new Error('YANDEX_POC_FOLDER must be an absolute safe Disk path');
  }
  return normalized.replace(/\/$/, '');
}

function validateRemoteSource(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('YANDEX_POC_SOURCE_URL must be an HTTPS URL without embedded credentials');
  }
  return url;
}

function parsePositiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(raw);
}

async function readBody(response) {
  const text = await response.text();
  return text.slice(0, 8_192);
}

function safeBody(body) {
  if (!body) {
    return '<empty>';
  }
  return body.replaceAll(/https?:\/\/[^\s"']+/g, '<redacted-url>');
}
