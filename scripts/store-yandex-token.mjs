import { constants } from 'node:fs';
import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const secretsDirectory = path.join(projectRoot, 'runtime', 'secrets');
const tokenPath = path.join(secretsDirectory, 'yandex-token');

if (!process.stdin.isTTY) {
  console.error('Нужен интерактивный Terminal: token читается без отображения ввода.');
  process.exit(1);
}

if (process.env.YANDEX_TOKEN_OVERWRITE !== '1') {
  try {
    await access(tokenPath, constants.F_OK);
    console.error('Token уже сохранён. Для замены запустите с YANDEX_TOKEN_OVERWRITE=1.');
    process.exit(1);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

process.stderr.write('Вставьте Yandex Disk OAuth token и нажмите Enter: ');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');

const token = await new Promise((resolve, reject) => {
  let input = '';

  const finish = () => {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stderr.write('\n');
    resolve(input.trim());
  };

  process.stdin.on('data', (chunk) => {
    for (const character of chunk) {
      if (character === '\u0003') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stderr.write('\nОтменено.\n');
        process.exit(130);
      }

      if (character === '\r' || character === '\n') {
        finish();
        return;
      }

      if (character === '\u007f') {
        input = input.slice(0, -1);
        continue;
      }

      input += character;
    }
  });

  process.stdin.on('error', reject);
});

if (token.length < 20 || /\s/.test(token)) {
  console.error('Token не сохранён: значение выглядит некорректно.');
  process.exit(1);
}

await mkdir(secretsDirectory, { recursive: true, mode: 0o700 });
await chmod(secretsDirectory, 0o700);
await writeFile(tokenPath, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
await chmod(tokenPath, 0o600);

console.log(`Token сохранён локально: ${path.relative(projectRoot, tokenPath)} (0600, Git ignored)`);
