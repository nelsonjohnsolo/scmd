#!/usr/bin/env node

const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { Readable } = require('node:stream');

const NO_CLIENT_EXIT_MS = 10_000;
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const MAX_INSTRUCTION_FILE_BYTES = 256 * 1024;
const MAX_TRASH_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_APPLY_DECISIONS = 10_000;
const REVIEW_LOCK_RETRY_MS = 25;
const REVIEW_LOCK_TIMEOUT_MS = 2_000;
const APPLY_LOCK_RETRY_MS = 25;
const APPLY_LOCK_TIMEOUT_MS = 2_000;
const CLAUDE_REWRITE_TIMEOUT_MS = 60_000;
const MAX_CLAUDE_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_REWRITE_CONTENT_BYTES = 512 * 1024;
const CLAUDE_FAST_MODEL = 'haiku';
const ORIGIN_LIMITS = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  timeoutMs: 10_000,
  maxTranscripts: 20,
});
const REVIEW_HISTORY_NOTICE = 'Review history could not be read. All memories are shown as unreviewed.';
const reviewHistoryQueues = new Map();

const CLAUDE_NESTING_ENV = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_PARENT_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
]);

const CONTROL_ESCAPES = {
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\v': '\\v',
  '\f': '\\f',
  '\r': '\\r',
};

function display(value) {
  return String(value).replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, (character) => (
    CONTROL_ESCAPES[character] || `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`
  ));
}

function fail(message) {
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
}

function parsePort(value) {
  if (!/^\d+$/.test(value)) return undefined;

  const port = Number(value);
  return port <= 65_535 ? port : undefined;
}

function parseArgs(args) {
  const options = {
    root: path.join(os.homedir(), '.claude', 'projects'),
    stateDir: path.join(os.homedir(), '.scmd'),
    port: 0,
    openBrowser: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];

    if (flag === '--no-open') {
      options.openBrowser = false;
      continue;
    }

    if (!['--root', '--state-dir', '--port'].includes(flag)) {
      fail(`Unknown option: ${display(flag)}`);
      return;
    }

    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      fail(`Missing value for ${flag}`);
      return;
    }
    index += 1;

    if (flag === '--port') {
      const port = parsePort(value);
      if (port === undefined) {
        fail(`Invalid port: ${display(value)}. Use an integer from 0 to 65535.`);
        return;
      }
      options.port = port;
    } else if (flag === '--root') {
      options.root = path.resolve(value);
      options.rootInput = value;
    } else {
      options.stateDir = path.resolve(value);
    }
  }

  return options;
}

function rootExists(root) {
  try {
    return fs.statSync(root).isDirectory();
  } catch {
    return false;
  }
}

function isLoopbackHost(host) {
  if (typeof host !== 'string') return false;

  const match = /^(?:127\.0\.0\.1|localhost)(?::(\d{1,5}))?$/i.exec(host);
  return Boolean(match && (!match[1] || Number(match[1]) <= 65_535));
}

function hasToken(request, token) {
  const supplied = request.headers['x-scmd-token'];
  if (typeof supplied !== 'string') return false;

  const expectedBytes = Buffer.from(token);
  const suppliedBytes = Buffer.from(supplied);
  return suppliedBytes.length === expectedBytes.length
    && crypto.timingSafeEqual(suppliedBytes, expectedBytes);
}

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function requestBodyError(statusCode, code, message, cause) {
  const error = new Error(message, { cause });
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function readJsonRequest(request) {
  const declaredLength = request.headers['content-length'];
  if (
    typeof declaredLength === 'string'
    && /^\d+$/.test(declaredLength)
    && Number(declaredLength) > MAX_JSON_BODY_BYTES
  ) {
    request.pause();
    return Promise.reject(requestBodyError(
      413,
      'request-too-large',
      'Request body is too large.',
    ));
  }

  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let byteLength = 0;
    let settled = false;

    const cleanup = () => {
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('error', onError);
      request.removeListener('aborted', onAborted);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      request.pause();
      rejectBody(error);
    };
    const onData = (chunk) => {
      byteLength += chunk.length;
      if (byteLength > MAX_JSON_BODY_BYTES) {
        rejectOnce(requestBodyError(413, 'request-too-large', 'Request body is too large.'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        resolveBody(JSON.parse(decodeUtf8(Buffer.concat(chunks), 'Request body')));
      } catch (cause) {
        rejectBody(requestBodyError(400, 'invalid-json', 'Request body must be valid JSON.', cause));
      }
    };
    const onError = (cause) => rejectOnce(requestBodyError(
      400,
      'request-read-failed',
      'Could not read request body.',
      cause,
    ));
    const onAborted = () => onError(new Error('Request body was aborted.'));

    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
  });
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function unreadableCode(error) {
  if (error && error.code === 'invalid-utf8') return 'invalid-utf8';
  if (error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(error.code)) {
    return error.code;
  }
  return 'unreadable';
}

function decodeUtf8(bytes, subject) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    const error = new Error(`${subject} is not valid UTF-8.`, { cause });
    error.code = 'invalid-utf8';
    throw error;
  }
}

async function findNewestTranscript(projectPath) {
  const entries = await fs.promises.readdir(projectPath, { withFileTypes: true });
  const transcripts = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(async (entry) => {
      try {
        const stats = await fs.promises.stat(path.join(projectPath, entry.name));
        return { name: entry.name, mtimeMs: stats.mtimeMs };
      } catch {
        return undefined;
      }
    }));

  return transcripts
    .filter(Boolean)
    .sort((left, right) => right.mtimeMs - left.mtimeMs || compareStrings(left.name, right.name))[0];
}

async function readTranscriptCwd(transcriptPath) {
  const input = fs.createReadStream(transcriptPath);
  const lines = readline.createInterface({
    input,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (
          record
          && typeof record === 'object'
          && !Array.isArray(record)
          && Object.prototype.hasOwnProperty.call(record, 'cwd')
          && typeof record.cwd === 'string'
          && record.cwd.trim()
        ) {
          return record.cwd;
        }
      } catch {
        // A malformed transcript line does not invalidate later lines.
      }
    }
  } catch {
    return undefined;
  } finally {
    lines.close();
    input.destroy();
  }
}

function resolveProjectPath(projectPath, cache) {
  if (!cache.has(projectPath)) {
    cache.set(projectPath, (async () => {
      try {
        const newest = await findNewestTranscript(projectPath);
        if (!newest) return undefined;
        return readTranscriptCwd(path.join(projectPath, newest.name));
      } catch {
        return undefined;
      }
    })());
  }

  return cache.get(projectPath);
}

function originNotFound(reason) {
  return { status: 'not-found', reason };
}

function originTargetFields(target) {
  const card = target && typeof target === 'object' && target.card
    ? target.card
    : target;
  if (!card || typeof card !== 'object' || Array.isArray(card)) return undefined;

  const projectId = firstValue(card.projectId, target?.projectId);
  const fileName = firstValue(card.fileName, target?.fileName);
  if (
    !safePathSegment(projectId)
    || !safePathSegment(fileName)
    || !fileName.endsWith('.md')
  ) return undefined;

  return {
    projectId,
    fileName,
    originSessionId: firstValue(card.originSessionId, target?.originSessionId),
  };
}

async function safeOriginProject(root, rootRealPath, projectId, budget) {
  if (!safePathSegment(projectId)) return undefined;
  const projectPath = path.join(root, projectId);
  let listedStats;
  let realPath;
  try {
    [listedStats, realPath] = await originAwait(budget, () => Promise.all([
      budget.fsPromises.lstat(projectPath),
      budget.fsPromises.realpath(projectPath),
    ]));
  } catch (error) {
    if (error?.code === 'origin-timeout') throw error;
    return undefined;
  }
  if (
    listedStats.isSymbolicLink()
    || !listedStats.isDirectory()
    || !sameFilesystemPath(realPath, path.join(rootRealPath, projectId))
    || !pathIsWithin(rootRealPath, realPath)
  ) return undefined;

  return {
    projectId,
    path: projectPath,
    realPath,
    dev: listedStats.dev,
    ino: listedStats.ino,
  };
}

async function listSafeOriginProjects(root, rootRealPath, budget) {
  const entries = await originAwait(
    budget,
    () => budget.fsPromises.readdir(root, { withFileTypes: true }),
  );
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !safePathSegment(entry.name)) continue;
    const project = await safeOriginProject(root, rootRealPath, entry.name, budget);
    if (project) projects.push(project);
  }
  return projects.sort((left, right) => compareStrings(left.projectId, right.projectId));
}

async function inspectOriginTranscript(project, fileName, budget) {
  if (!safePathSegment(fileName) || !fileName.endsWith('.jsonl')) return undefined;
  const transcriptPath = path.join(project.path, fileName);
  let listedStats;
  let realPath;
  try {
    [listedStats, realPath] = await originAwait(budget, () => Promise.all([
      budget.fsPromises.lstat(transcriptPath),
      budget.fsPromises.realpath(transcriptPath),
    ]));
  } catch (error) {
    if (error?.code === 'origin-timeout') throw error;
    return undefined;
  }
  if (
    listedStats.isSymbolicLink()
    || !listedStats.isFile()
    || !sameFilesystemPath(realPath, path.join(project.realPath, fileName))
    || !pathIsWithin(project.realPath, realPath)
  ) return undefined;

  return {
    project,
    fileName,
    path: transcriptPath,
    dev: listedStats.dev,
    ino: listedStats.ino,
    size: listedStats.size,
    mtimeMs: listedStats.mtimeMs,
  };
}

async function listRecentOriginTranscripts(project, maxTranscripts, budget) {
  let entries;
  try {
    entries = await originAwait(
      budget,
      () => budget.fsPromises.readdir(project.path, { withFileTypes: true }),
    );
  } catch (error) {
    if (error?.code === 'origin-timeout') throw error;
    return [];
  }
  const transcripts = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const transcript = await inspectOriginTranscript(project, entry.name, budget);
    if (transcript) transcripts.push(transcript);
  }
  return transcripts
    .sort((left, right) => (
      right.mtimeMs - left.mtimeMs || compareStrings(left.fileName, right.fileName)
    ))
    .slice(0, maxTranscripts);
}

async function closeOriginHandle(handle, budget) {
  let closePromise;
  try {
    closePromise = Promise.resolve(handle.close());
  } catch {
    return;
  }
  closePromise.catch(() => {});
  try {
    await originAwait(budget, () => closePromise);
  } catch {
    // Closing continues in the background with its rejection observed.
  }
}

async function openOriginTranscript(transcript, budget) {
  let handle;
  try {
    handle = await originAwait(
      budget,
      () => budget.fsPromises.open(
        transcript.path,
        fs.constants.O_RDONLY | budget.noFollowFlag,
      ),
      (lateHandle) => closeOriginHandle(lateHandle, budget),
    );
    const [openedStats, projectStats, projectRealPath] = await originAwait(
      budget,
      () => Promise.all([
      handle.stat(),
      budget.fsPromises.lstat(transcript.project.path),
      budget.fsPromises.realpath(transcript.project.path),
      ]),
    );
    if (
      !openedStats.isFile()
      || openedStats.dev !== transcript.dev
      || openedStats.ino !== transcript.ino
      || projectStats.isSymbolicLink()
      || !projectStats.isDirectory()
      || projectStats.dev !== transcript.project.dev
      || projectStats.ino !== transcript.project.ino
      || !sameFilesystemPath(projectRealPath, transcript.project.realPath)
    ) {
      await closeOriginHandle(handle, budget);
      return undefined;
    }
    return handle;
  } catch (error) {
    if (handle) await closeOriginHandle(handle, budget);
    if (error?.code === 'origin-timeout') throw error;
    return undefined;
  }
}

function originUserMessage(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const message = record.message && typeof record.message === 'object'
    ? record.message
    : record;
  if (record.type !== 'user' && message.role !== 'user') return undefined;

  const content = message.content;
  let text;
  if (typeof content === 'string') {
    text = content.trim();
  } else if (Array.isArray(content)) {
    text = content
      .filter((part) => (
        part
        && typeof part === 'object'
        && part.type === 'text'
        && typeof part.text === 'string'
      ))
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join('\n');
  }
  if (!text) return undefined;

  return {
    message: text,
    date: validIsoDate(record.timestamp) || validIsoDate(message.timestamp),
  };
}

function originToolWritesTarget(tool, target) {
  if (
    !tool
    || typeof tool !== 'object'
    || Array.isArray(tool)
    || tool.type !== 'tool_use'
    || typeof tool.name !== 'string'
  ) return false;
  if (tool.name !== 'Write') return false;
  if (!tool.input || typeof tool.input !== 'object' || Array.isArray(tool.input)) return false;
  const inputPath = firstValue(tool.input.file_path, tool.input.filePath, tool.input.path);
  if (!inputPath) return false;

  const parts = inputPath
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);
  const suffix = [target.projectId, 'memory', target.fileName];
  if (parts.length < suffix.length) return false;
  return suffix.every((part, index) => (
    sameFilesystemPath(parts[parts.length - suffix.length + index], part)
  ));
}

function originRecordWritesTarget(record, target) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const message = record.message && typeof record.message === 'object'
    ? record.message
    : record;
  if (record.type !== 'assistant' && message.role !== 'assistant') return false;
  if (!Array.isArray(message.content)) return false;
  return message.content.some((part) => originToolWritesTarget(part, target));
}

function originBudgetExpired(budget) {
  return budget.nowImpl() - budget.startedAt >= budget.timeoutMs;
}

function originTimeoutError() {
  const error = new Error('Origin lookup timed out.');
  error.code = 'origin-timeout';
  return error;
}

function originAwait(budget, operation, onLateResolve) {
  if (originBudgetExpired(budget)) return Promise.reject(originTimeoutError());

  let pending;
  try {
    pending = Promise.resolve(operation());
  } catch (error) {
    pending = Promise.reject(error);
  }

  return new Promise((resolveOperation, rejectOperation) => {
    let settled = false;
    const remainingMs = Math.max(
      0,
      budget.timeoutMs - (budget.nowImpl() - budget.startedAt),
    );
    const timer = budget.setTimeoutImpl(() => {
      if (settled) return;
      settled = true;
      rejectOperation(originTimeoutError());
    }, remainingMs);

    pending.then(
      (value) => {
        if (settled) {
          if (onLateResolve) {
            Promise.resolve()
              .then(() => onLateResolve(value))
              .catch(() => {});
          }
          return;
        }
        settled = true;
        budget.clearTimeoutImpl(timer);
        resolveOperation(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        budget.clearTimeoutImpl(timer);
        rejectOperation(error);
      },
    );
  });
}

function createOriginBudget(options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes >= 0
    ? Math.floor(options.maxBytes)
    : ORIGIN_LIMITS.maxBytes;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs >= 0
    ? options.timeoutMs
    : ORIGIN_LIMITS.timeoutMs;
  const maxTranscripts = Number.isInteger(options.maxTranscripts) && options.maxTranscripts >= 0
    ? options.maxTranscripts
    : ORIGIN_LIMITS.maxTranscripts;
  const nowImpl = typeof options.nowImpl === 'function' ? options.nowImpl : Date.now;
  const setTimeoutImpl = typeof options.setTimeoutImpl === 'function'
    ? options.setTimeoutImpl
    : setTimeout;
  const clearTimeoutImpl = typeof options.clearTimeoutImpl === 'function'
    ? options.clearTimeoutImpl
    : clearTimeout;
  return {
    bytes: 0,
    clearTimeoutImpl,
    fsPromises: options.fsPromises || fs.promises,
    maxBytes,
    maxTranscripts,
    noFollowFlag: Number.isInteger(options.noFollowFlag)
      ? options.noFollowFlag
      : (fs.constants.O_NOFOLLOW || 0),
    timeoutMs,
    nowImpl,
    setTimeoutImpl,
    startedAt: nowImpl(),
  };
}

async function inspectOriginMemoryDirectory(project, rootRealPath, budget) {
  const memoryPath = path.join(project.path, 'memory');
  const expectedRealPath = path.join(project.realPath, 'memory');
  let listedStats;
  let realPath;
  try {
    [listedStats, realPath] = await originAwait(budget, () => Promise.all([
      budget.fsPromises.lstat(memoryPath, { bigint: true }),
      budget.fsPromises.realpath(memoryPath),
    ]));
  } catch (error) {
    if (error?.code === 'origin-timeout') throw error;
    return undefined;
  }
  if (
    listedStats.isSymbolicLink()
    || !listedStats.isDirectory()
    || !sameFilesystemPath(realPath, expectedRealPath)
    || !pathIsWithin(rootRealPath, realPath)
  ) return undefined;

  let directoryStats = listedStats;
  if (Number.isInteger(fs.constants.O_DIRECTORY)) {
    let handle;
    try {
      handle = await originAwait(
        budget,
        () => budget.fsPromises.open(
          memoryPath,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | budget.noFollowFlag,
        ),
        (lateHandle) => closeOriginHandle(lateHandle, budget),
      );
      const openedStats = await originAwait(
        budget,
        () => handle.stat({ bigint: true }),
      );
      if (!openedStats.isDirectory() || !sameFileIdentity(openedStats, listedStats)) {
        await closeOriginHandle(handle, budget);
        return undefined;
      }
      directoryStats = openedStats;
    } catch (error) {
      if (handle) await closeOriginHandle(handle, budget);
      if (error?.code === 'origin-timeout') throw error;
      return undefined;
    }
    await closeOriginHandle(handle, budget);
  }

  return {
    memoryPath,
    realPath,
    rootRealPath,
    stats: directoryStats,
  };
}

async function originMemoryDirectoryMatches(directory, budget) {
  try {
    const [listedStats, realPath] = await originAwait(budget, () => Promise.all([
      budget.fsPromises.lstat(directory.memoryPath, { bigint: true }),
      budget.fsPromises.realpath(directory.memoryPath),
    ]));
    return Boolean(
      !listedStats.isSymbolicLink()
      && listedStats.isDirectory()
      && sameFileIdentity(listedStats, directory.stats)
      && sameFilesystemPath(realPath, directory.realPath)
      && pathIsWithin(directory.rootRealPath, realPath)
    );
  } catch (error) {
    if (error?.code === 'origin-timeout') throw error;
    return false;
  }
}

async function inspectOriginMemoryFile(memoryDirectory, fileName, budget) {
  const filePath = path.join(memoryDirectory.memoryPath, fileName);
  const expectedRealPath = path.join(memoryDirectory.realPath, fileName);
  try {
    const [listedStats, realPath] = await originAwait(budget, () => Promise.all([
      budget.fsPromises.lstat(filePath, { bigint: true }),
      budget.fsPromises.realpath(filePath),
    ]));
    if (
      listedStats.isSymbolicLink()
      || !listedStats.isFile()
      || !sameFilesystemPath(realPath, expectedRealPath)
      || !pathIsWithin(memoryDirectory.realPath, realPath)
    ) return undefined;
    return { filePath, expectedRealPath, listedStats };
  } catch (error) {
    if (error?.code === 'origin-timeout') throw error;
    return undefined;
  }
}

async function validateOpenedOriginMemoryFile(
  handle,
  inspectedFile,
  memoryDirectory,
  budget,
) {
  try {
    const [openedStats, listedStats, realPath, directoryMatches] = await originAwait(
      budget,
      () => Promise.all([
        handle.stat({ bigint: true }),
        budget.fsPromises.lstat(inspectedFile.filePath, { bigint: true }),
        budget.fsPromises.realpath(inspectedFile.filePath),
        originMemoryDirectoryMatches(memoryDirectory, budget),
      ]),
    );
    if (
      !openedStats.isFile()
      || listedStats.isSymbolicLink()
      || !listedStats.isFile()
      || !sameFileIdentity(openedStats, listedStats)
      || !sameFileVersion(inspectedFile.listedStats, listedStats)
      || !sameFilesystemPath(realPath, inspectedFile.expectedRealPath)
      || !pathIsWithin(memoryDirectory.realPath, realPath)
      || !directoryMatches
    ) return undefined;
    return openedStats;
  } catch (error) {
    if (error?.code === 'origin-timeout') throw error;
    return undefined;
  }
}

async function readOriginMemoryTarget(
  project,
  memoryDirectory,
  fileName,
  memoryFileNames,
  budget,
) {
  if (!safePathSegment(fileName) || !fileName.endsWith('.md')) return undefined;
  if (!await originMemoryDirectoryMatches(memoryDirectory, budget)) return undefined;
  const inspectedFile = await inspectOriginMemoryFile(memoryDirectory, fileName, budget);
  if (!inspectedFile) return undefined;
  const { filePath } = inspectedFile;
  let handle;
  try {
    handle = await originAwait(
      budget,
      () => budget.fsPromises.open(
        filePath,
        fs.constants.O_RDONLY | budget.noFollowFlag,
      ),
      (lateHandle) => closeOriginHandle(lateHandle, budget),
    );
    const openedStats = await validateOpenedOriginMemoryFile(
      handle,
      inspectedFile,
      memoryDirectory,
      budget,
    );
    if (!openedStats) return undefined;

    const bytes = await originAwait(budget, () => handle.readFile());
    const finalStats = await validateOpenedOriginMemoryFile(
      handle,
      inspectedFile,
      memoryDirectory,
      budget,
    );
    if (
      !finalStats
      || !sameFileVersion(openedStats, finalStats)
    ) return undefined;

    const card = createMemoryCard({
      projectId: project.projectId,
      fileName,
      bytes,
      mtime: finalStats.mtime,
    });
    return {
      projectId: project.projectId,
      fileName,
      memoryPath: memoryDirectory.memoryPath,
      memoryRealPath: memoryDirectory.realPath,
      rootRealPath: memoryDirectory.rootRealPath,
      memoryDev: memoryDirectory.stats.dev,
      memoryIno: memoryDirectory.stats.ino,
      filePath,
      indexPath: path.join(memoryDirectory.memoryPath, 'MEMORY.md'),
      card,
      memoryFileNames,
    };
  } catch (error) {
    if (error?.code === 'origin-timeout') throw error;
    return undefined;
  } finally {
    if (handle) await closeOriginHandle(handle, budget);
  }
}

async function resolveOriginTargetWithBudget(root, id, budget) {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  const rootRealPath = await originAwait(
    budget,
    () => budget.fsPromises.realpath(root),
  );
  const projectEntries = await originAwait(
    budget,
    () => budget.fsPromises.readdir(root, { withFileTypes: true }),
  );

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory() || !safePathSegment(projectEntry.name)) continue;
    const project = await safeOriginProject(
      root,
      rootRealPath,
      projectEntry.name,
      budget,
    );
    if (!project) continue;
    const memoryDirectory = await inspectOriginMemoryDirectory(
      project,
      rootRealPath,
      budget,
    );
    if (!memoryDirectory) continue;

    let memoryEntries;
    try {
      memoryEntries = await originAwait(
        budget,
        () => budget.fsPromises.readdir(memoryDirectory.memoryPath, { withFileTypes: true }),
      );
    } catch (error) {
      if (error?.code === 'origin-timeout') throw error;
      continue;
    }
    if (!await originMemoryDirectoryMatches(memoryDirectory, budget)) continue;
    const memoryFileNames = memoryEntries
      .filter((entry) => (
        entry.isFile()
        && entry.name.endsWith('.md')
        && entry.name !== 'MEMORY.md'
        && safePathSegment(entry.name)
      ))
      .map((entry) => entry.name);

    for (const fileName of memoryFileNames) {
      if (`${project.projectId}/${fileName}` !== id) continue;
      return readOriginMemoryTarget(
        project,
        memoryDirectory,
        fileName,
        memoryFileNames,
        budget,
      );
    }
  }
  return undefined;
}

function resolveOriginTarget(root, id, options = {}) {
  return resolveOriginTargetWithBudget(root, id, createOriginBudget(options));
}

async function scanOriginTranscript(transcript, target, budget) {
  if (originBudgetExpired(budget)) return originNotFound('lookup-timed-out');
  const handle = await openOriginTranscript(transcript, budget);
  if (!handle) return { status: 'unreadable' };

  const remainingAtStart = budget.maxBytes - budget.bytes;
  if (remainingAtStart <= 0) {
    await closeOriginHandle(handle, budget);
    return transcript.size > 0
      ? originNotFound('transcript-too-large')
      : { status: 'not-in-transcript' };
  }
  let source;
  let bounded;
  let lines;
  let timer;
  let timedOut = false;
  let tooLarge = transcript.size > remainingAtStart;
  let sawWriteWithoutMessage = false;
  let previousUser;
  try {
    source = handle.createReadStream({
      autoClose: false,
      end: remainingAtStart - 1,
    });
    const remainingMs = Math.max(
      1,
      budget.timeoutMs - (budget.nowImpl() - budget.startedAt),
    );
    const timeoutError = originTimeoutError();
    timer = budget.setTimeoutImpl(() => {
      timedOut = true;
      source.destroy(timeoutError);
    }, remainingMs);

    bounded = Readable.from((async function* boundedTranscript() {
      for await (const chunk of source) {
        if (originBudgetExpired(budget)) {
          timedOut = true;
          return;
        }
        const remainingBytes = budget.maxBytes - budget.bytes;
        if (remainingBytes <= 0) {
          tooLarge = true;
          return;
        }
        if (chunk.length > remainingBytes) {
          budget.bytes += remainingBytes;
          yield chunk.subarray(0, remainingBytes);
          tooLarge = true;
          return;
        }
        budget.bytes += chunk.length;
        yield chunk;
      }
    }()));
    lines = readline.createInterface({ input: bounded, crlfDelay: Infinity });

    for await (const line of lines) {
      if (originBudgetExpired(budget)) {
        timedOut = true;
        break;
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const userMessage = originUserMessage(record);
      if (userMessage) previousUser = userMessage;
      if (!originRecordWritesTarget(record, target)) continue;
      if (!previousUser) {
        sawWriteWithoutMessage = true;
        continue;
      }
      return {
        status: 'found',
        message: previousUser.message,
        date: previousUser.date || new Date(transcript.mtimeMs).toISOString(),
      };
    }
    if (timedOut) return originNotFound('lookup-timed-out');
    if (tooLarge) return originNotFound('transcript-too-large');
    return sawWriteWithoutMessage
      ? { status: 'missing-message' }
      : { status: 'not-in-transcript' };
  } catch (error) {
    if (timedOut || error?.code === 'origin-timeout') {
      return originNotFound('lookup-timed-out');
    }
    return { status: 'unreadable' };
  } finally {
    if (timer) budget.clearTimeoutImpl(timer);
    if (lines) lines.close();
    if (bounded) bounded.destroy();
    if (source) source.destroy();
    await closeOriginHandle(handle, budget);
  }
}

async function findMemoryOriginWithBudget(root, target, budget) {
  const normalizedTarget = originTargetFields(target);
  if (!normalizedTarget) return originNotFound('write-not-found');

  try {
    const rootRealPath = await originAwait(
      budget,
      () => budget.fsPromises.realpath(root),
    );
    const projects = await listSafeOriginProjects(root, rootRealPath, budget);
    if (originBudgetExpired(budget)) return originNotFound('lookup-timed-out');
    const ownProject = projects.find((project) => (
      project.projectId === normalizedTarget.projectId
    ));
    let transcripts;

    if (normalizedTarget.originSessionId) {
      if (!safePathSegment(normalizedTarget.originSessionId)) {
        return originNotFound('session-not-found');
      }
      const sessionFileName = `${normalizedTarget.originSessionId}.jsonl`;
      if (!safePathSegment(sessionFileName)) return originNotFound('session-not-found');
      const orderedProjects = ownProject
        ? [ownProject, ...projects.filter((project) => project !== ownProject)]
        : projects;
      transcripts = [];
      for (const project of orderedProjects) {
        const transcript = await inspectOriginTranscript(project, sessionFileName, budget);
        if (transcript) transcripts.push(transcript);
      }
      if (transcripts.length === 0) return originNotFound('session-not-found');
    } else {
      if (!ownProject) return originNotFound('write-not-found');
      transcripts = await listRecentOriginTranscripts(
        ownProject,
        budget.maxTranscripts,
        budget,
      );
    }

    let sawUnreadable = false;
    let sawWriteWithoutMessage = false;
    for (const transcript of transcripts) {
      const result = await scanOriginTranscript(transcript, normalizedTarget, budget);
      if (result.status === 'found' || result.status === 'not-found') return result;
      if (result.status === 'unreadable') sawUnreadable = true;
      if (result.status === 'missing-message') sawWriteWithoutMessage = true;
    }
    if (originBudgetExpired(budget)) return originNotFound('lookup-timed-out');
    if (sawWriteWithoutMessage) return originNotFound('preceding-message-not-found');
    if (sawUnreadable) return originNotFound('transcript-unreadable');
    return originNotFound('write-not-found');
  } catch (error) {
    if (error?.code === 'origin-timeout') return originNotFound('lookup-timed-out');
    return originNotFound('lookup-failed');
  }
}

function findMemoryOrigin(root, target, options = {}) {
  return findMemoryOriginWithBudget(root, target, createOriginBudget(options));
}

async function readMemoryCardResult(memoryPath, projectId, fileName, memoryDirectory) {
  const filePath = path.join(memoryPath, fileName);
  let handle;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
    const bytes = await handle.readFile();
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('Memory path is not a regular file.');
    return {
      card: createMemoryCard({ projectId, fileName, bytes, mtime: stats.mtime }),
      target: {
        projectId,
        fileName,
        memoryPath,
        memoryRealPath: memoryDirectory.realPath,
        rootRealPath: memoryDirectory.rootRealPath,
        memoryDev: memoryDirectory.stats.dev,
        memoryIno: memoryDirectory.stats.ino,
        filePath,
        indexPath: path.join(memoryPath, 'MEMORY.md'),
      },
    };
  } catch (error) {
    return {
      unreadable: {
        fileName,
        code: unreadableCode(error),
      },
    };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function openingFence(line) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return undefined;
  return { marker: match[1][0], length: match[1].length };
}

function closesFence(line, fence) {
  const match = /^ {0,3}(`+|~+)[\t ]*$/.exec(line);
  return Boolean(
    match
    && match[1][0] === fence.marker
    && match[1].length >= fence.length,
  );
}

function isDirectMemoryTarget(target) {
  return safePathSegment(target) && target.endsWith('.md');
}

function matchIndexLine(line, availableFileNames) {
  const match = /^[\t ]*- \[((?:\\[^\r\n]|[^\]\\\r\n])*)\]\(((?:\\[^\r\n]|[^)\\\r\n])+)\)/.exec(line);
  if (!match) return undefined;
  const explicitlyEncoded = match[2].includes('\\%');
  const literalTarget = match[2].replace(/\\([\\()%])/g, '$1');
  const candidates = [];
  if (!explicitlyEncoded && isDirectMemoryTarget(literalTarget)) candidates.push(literalTarget);
  try {
    const decodedTarget = decodeURIComponent(literalTarget);
    if (
      decodedTarget !== literalTarget
      && isDirectMemoryTarget(decodedTarget)
    ) candidates.push(decodedTarget);
  } catch {
    // A literal percent is valid in a filename even when it is not URI syntax.
  }
  if (candidates.length === 0) return undefined;
  const available = availableFileNames instanceof Set
    ? availableFileNames
    : new Set(availableFileNames || []);
  const target = candidates.find((candidate) => available.has(candidate)) || candidates[0];
  return {
    raw: match[0],
    target,
  };
}

function parseIndex(text, memoryFileNames) {
  const available = new Set(memoryFileNames);
  const indexed = new Set();
  const dangling = [];
  const lines = text.split(/\r\n|\n|\r/);
  let fence;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      if (closesFence(line, fence)) fence = undefined;
      continue;
    }

    fence = openingFence(line);
    if (fence) continue;

    const match = matchIndexLine(line, available);
    if (!match) continue;

    const fileName = match.target;
    if (!isDirectMemoryTarget(fileName)) continue;
    if (available.has(fileName)) {
      indexed.add(fileName);
    } else {
      dangling.push({
        fileName,
        lineNumber: index + 1,
        line,
      });
    }
  }

  return {
    unindexed: memoryFileNames.filter((fileName) => !indexed.has(fileName)),
    dangling,
  };
}

async function readIndexHealth(memoryPath, memoryFileNames) {
  const indexPath = path.join(memoryPath, 'MEMORY.md');
  let bytes;
  let handle;
  try {
    const listedStats = await fs.promises.lstat(indexPath);
    if (listedStats.isSymbolicLink()) {
      return {
        unindexed: [...memoryFileNames],
        dangling: [],
        unreadable: [{ fileName: 'MEMORY.md', code: 'symlink' }],
      };
    }
    if (!listedStats.isFile()) {
      return {
        unindexed: [...memoryFileNames],
        dangling: [],
        unreadable: [{ fileName: 'MEMORY.md', code: 'not-regular-file' }],
      };
    }

    const noFollow = fs.constants.O_NOFOLLOW || 0;
    handle = await fs.promises.open(indexPath, fs.constants.O_RDONLY | noFollow);
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) {
      return {
        unindexed: [...memoryFileNames],
        dangling: [],
        unreadable: [{ fileName: 'MEMORY.md', code: 'not-regular-file' }],
      };
    }
    bytes = await handle.readFile();
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { unindexed: [...memoryFileNames], dangling: [], unreadable: [] };
    }
    return {
      unindexed: [...memoryFileNames],
      dangling: [],
      unreadable: [{ fileName: 'MEMORY.md', code: unreadableCode(error) }],
    };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }

  try {
    return {
      ...parseIndex(decodeUtf8(bytes, 'Memory index'), memoryFileNames),
      unreadable: [],
    };
  } catch (error) {
    return {
      unindexed: [...memoryFileNames],
      dangling: [],
      unreadable: [{ fileName: 'MEMORY.md', code: unreadableCode(error) }],
    };
  }
}

function sameFilesystemPath(left, right) {
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function pathIsWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function inspectSafeMemoryDirectory(memoryPath, expectedRealPath, realRoot) {
  let listedStats;
  try {
    listedStats = await fs.promises.lstat(memoryPath, { bigint: true });
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
  if (listedStats.isSymbolicLink() || !listedStats.isDirectory()) return false;

  let realMemoryPath;
  try {
    realMemoryPath = await fs.promises.realpath(memoryPath);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
  if (
    !pathIsWithin(realRoot, realMemoryPath)
    || !sameFilesystemPath(realMemoryPath, expectedRealPath)
  ) return false;

  if (!Number.isInteger(fs.constants.O_DIRECTORY)) {
    return { realPath: realMemoryPath, rootRealPath: realRoot, stats: listedStats };
  }

  let handle;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    handle = await fs.promises.open(
      memoryPath,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | noFollow,
    );
    const openedStats = await handle.stat({ bigint: true });
    if (!openedStats.isDirectory() || !sameFileIdentity(openedStats, listedStats)) return false;
    return { realPath: realMemoryPath, rootRealPath: realRoot, stats: openedStats };
  } catch (error) {
    if (error && ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return false;
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function isSnapshotMemoryFile(fileName) {
  return (
    safePathSegment(fileName)
    && fileName.endsWith('.md')
    && fileName !== 'MEMORY.md'
    && !fileName.startsWith('.scmd-')
    && !fileName.endsWith('.tmp.md')
  );
}

async function listMemorySnapshotDirectories(root) {
  const [entries, realRoot] = await Promise.all([
    fs.promises.readdir(root, { withFileTypes: true }),
    fs.promises.realpath(root),
  ]);
  const directories = [];

  for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
    if (!entry.isDirectory() || !safePathSegment(entry.name)) continue;
    const memoryPath = path.join(root, entry.name, 'memory');
    const expectedRealPath = path.join(realRoot, entry.name, 'memory');
    let inspected;
    try {
      inspected = await inspectSafeMemoryDirectory(memoryPath, expectedRealPath, realRoot);
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue;
      throw error;
    }
    if (inspected) directories.push({ projectId: entry.name, memoryPath, ...inspected });
  }

  return directories;
}

async function readSnapshotHash(directory, fileName, fsPromises = fs.promises) {
  const filePath = path.join(directory.memoryPath, fileName);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle;
    try {
      const listedStats = await fsPromises.lstat(filePath, { bigint: true });
      if (listedStats.isSymbolicLink() || !listedStats.isFile()) return undefined;

      const noFollow = fs.constants.O_NOFOLLOW || 0;
      handle = await fsPromises.open(filePath, fs.constants.O_RDONLY | noFollow);
      const openedStats = await handle.stat({ bigint: true });
      const realFilePath = await fsPromises.realpath(filePath);
      if (!openedStats.isFile()) return undefined;
      if (!sameFileIdentity(listedStats, openedStats)) continue;
      if (
        !sameFilesystemPath(realFilePath, path.join(directory.realPath, fileName))
        || !pathIsWithin(directory.rootRealPath, realFilePath)
      ) return undefined;

      const bytes = await handle.readFile();
      const finalStats = await handle.stat({ bigint: true });
      if (!sameFileVersion(openedStats, finalStats)) continue;
      return crypto.createHash('sha256').update(bytes).digest('hex');
    } catch (error) {
      if (error && ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return undefined;
      throw error;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  const error = new Error('Memory file kept changing during snapshot scan.');
  error.code = 'snapshot-changed';
  throw error;
}

async function scanMemorySnapshot(root, {
  previousSnapshot = new Map(),
  fsPromises = fs.promises,
} = {}) {
  const snapshot = new Map();
  const directories = await listMemorySnapshotDirectories(root);

  for (const directory of directories) {
    let entries;
    try {
      entries = await fsPromises.readdir(directory.memoryPath, { withFileTypes: true });
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue;
      const prefix = `${directory.projectId}/`;
      for (const [id, hash] of previousSnapshot) {
        if (id.startsWith(prefix)) snapshot.set(id, hash);
      }
      continue;
    }

    const files = entries
      .filter((entry) => entry.isFile() && isSnapshotMemoryFile(entry.name))
      .sort((left, right) => compareStrings(left.name, right.name));
    for (const file of files) {
      const id = `${directory.projectId}/${file.name}`;
      try {
        const hash = await readSnapshotHash(directory, file.name, fsPromises);
        if (hash) snapshot.set(id, hash);
      } catch {
        if (previousSnapshot.has(id)) snapshot.set(id, previousSnapshot.get(id));
      }
    }
  }

  return snapshot;
}

async function listMemoryWatchPaths(root) {
  const [entries, realRoot] = await Promise.all([
    fs.promises.readdir(root, { withFileTypes: true }),
    fs.promises.realpath(root),
  ]);
  const watchPaths = [root];

  for (const entry of entries.sort((left, right) => compareStrings(left.name, right.name))) {
    if (!entry.isDirectory() || !safePathSegment(entry.name)) continue;
    const projectPath = path.join(root, entry.name);
    let projectStats;
    let realProjectPath;
    try {
      [projectStats, realProjectPath] = await Promise.all([
        fs.promises.lstat(projectPath, { bigint: true }),
        fs.promises.realpath(projectPath),
      ]);
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue;
      throw error;
    }
    if (
      projectStats.isSymbolicLink()
      || !projectStats.isDirectory()
      || !sameFilesystemPath(realProjectPath, path.join(realRoot, entry.name))
      || !pathIsWithin(realRoot, realProjectPath)
    ) continue;

    watchPaths.push(projectPath);
    const memoryPath = path.join(projectPath, 'memory');
    const memoryDirectory = await inspectSafeMemoryDirectory(
      memoryPath,
      path.join(realProjectPath, 'memory'),
      realRoot,
    );
    if (memoryDirectory) watchPaths.push(memoryPath);
  }

  return watchPaths;
}

function diffMemorySnapshots(before, after) {
  const added = [];
  const changed = [];
  const removed = [];

  for (const [id, hash] of after) {
    if (!before.has(id)) added.push({ type: 'added', id });
    else if (before.get(id) !== hash) changed.push({ type: 'changed', id });
  }
  for (const id of before.keys()) {
    if (!after.has(id)) removed.push({ type: 'removed', id });
  }

  const byId = (left, right) => compareStrings(left.id, right.id);
  return [...added.sort(byId), ...changed.sort(byId), ...removed.sort(byId)];
}

function createMemoryWatcher({
  root,
  memoryPaths,
  scan = (previousSnapshot) => scanMemorySnapshot(root, { previousSnapshot }),
  watch = fs.watch,
  emit = () => {},
  debounceMs = 300,
  pollIntervalMs = 5_000,
  timers = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  },
} = {}) {
  const watchers = new Map();
  const idleWaiters = [];
  let snapshot = new Map();
  let debounceTimer;
  let pollTimer;
  let scanning = false;
  let dirty = false;
  let holdCount = 0;
  let started = false;
  let stopped = false;
  let polling = false;
  let retryScan = false;
  let startPromise;

  function finishIdle() {
    for (const resolve of idleWaiters.splice(0)) resolve();
  }

  function closeWatchers() {
    for (const watcher of watchers.values()) {
      try {
        watcher.close();
      } catch {
        // A failed watcher is already unusable.
      }
    }
    watchers.clear();
  }

  function startPolling() {
    if (stopped || polling) return;
    polling = true;
    closeWatchers();
    pollTimer = timers.setInterval(() => requestScan(), pollIntervalMs);
    pollTimer.unref?.();
  }

  async function reconcileWatchers() {
    if (stopped || polling) return;
    const paths = memoryPaths === undefined
      ? await listMemoryWatchPaths(root)
      : memoryPaths;
    const desired = new Set(paths);

    for (const [watchPath, watcher] of watchers) {
      if (desired.has(watchPath)) continue;
      try {
        watcher.close();
      } catch {
        // A vanished path may already have closed its watcher.
      }
      watchers.delete(watchPath);
    }

    try {
      for (const watchPath of desired) {
        if (watchers.has(watchPath)) continue;
        const watcher = watch(watchPath, () => scheduleScan());
        watchers.set(watchPath, watcher);
        watcher.on?.('error', startPolling);
      }
    } catch {
      startPolling();
    }
  }

  async function scanUntilClean() {
    if (stopped || scanning || holdCount > 0) {
      dirty = true;
      return;
    }

    scanning = true;
    try {
      do {
        dirty = false;
        let nextSnapshot;
        try {
          await reconcileWatchers();
          nextSnapshot = await scan(new Map(snapshot));
        } catch {
          retryScan = true;
          break;
        }
        if (stopped) break;
        const events = diffMemorySnapshots(snapshot, nextSnapshot);
        snapshot = nextSnapshot;
        if (events.length > 0) emit(events);
      } while (dirty && !stopped && holdCount === 0);
    } finally {
      scanning = false;
      finishIdle();
      if (retryScan && !stopped) {
        retryScan = false;
        scheduleScan();
      }
    }
  }

  function requestScan() {
    if (stopped) return;
    if (scanning || holdCount > 0) {
      dirty = true;
      return;
    }
    void scanUntilClean();
  }

  function scheduleScan() {
    if (stopped) return;
    if (scanning || holdCount > 0) {
      dirty = true;
      return;
    }
    if (debounceTimer) timers.clearTimeout(debounceTimer);
    debounceTimer = timers.setTimeout(() => {
      debounceTimer = undefined;
      requestScan();
    }, debounceMs);
    debounceTimer.unref?.();
  }

  function start() {
    if (started || stopped) return Promise.resolve();
    if (startPromise) return startPromise;

    startPromise = (async () => {
      await reconcileWatchers();
      scanning = true;
      try {
        try {
          snapshot = await scan(new Map());
        } catch {
          startPolling();
          snapshot = await scan(new Map());
        }
        started = true;
      } finally {
        scanning = false;
        finishIdle();
      }
      if (dirty && !stopped) {
        dirty = false;
        scheduleScan();
      }
    })()
      .catch((error) => {
        started = false;
        closeWatchers();
        if (pollTimer) timers.clearInterval(pollTimer);
        pollTimer = undefined;
        polling = false;
        throw error;
      })
      .finally(() => {
        startPromise = undefined;
      });
    return startPromise;
  }

  async function beginMutation() {
    if (debounceTimer) {
      timers.clearTimeout(debounceTimer);
      debounceTimer = undefined;
      dirty = true;
    }
    if (scanning) await new Promise((resolve) => idleWaiters.push(resolve));
    if (stopped) return () => {};
    holdCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holdCount -= 1;
      if (holdCount === 0 && dirty) {
        dirty = false;
        scheduleScan();
      }
    };
  }

  function suppress(transitions) {
    for (const transition of transitions) {
      if (!transition || typeof transition.id !== 'string') continue;
      if (transition.type === 'removed') {
        snapshot.delete(transition.id);
      } else if (
        transition.type === 'changed'
        && typeof transition.hash === 'string'
      ) {
        snapshot.set(transition.id, transition.hash);
      }
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (debounceTimer) timers.clearTimeout(debounceTimer);
    if (pollTimer) timers.clearInterval(pollTimer);
    debounceTimer = undefined;
    pollTimer = undefined;
    closeWatchers();
  }

  return { beginMutation, start, stop, suppress };
}

function emptyReviewHistory() {
  return { version: 1, entries: {} };
}

function reviewHistoryError(code, message, cause) {
  const error = new Error(message, { cause });
  error.code = code;
  return error;
}

function isReviewHistory(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.version !== 1
    || !value.entries
    || typeof value.entries !== 'object'
    || Array.isArray(value.entries)
  ) return false;

  return Object.entries(value.entries).every(([hash, entry]) => (
    /^[a-f0-9]{64}$/.test(hash)
    && entry
    && typeof entry === 'object'
    && !Array.isArray(entry)
    && typeof entry.id === 'string'
    && entry.id.length > 0
    && validIsoDate(entry.at) === entry.at
  ));
}

async function readReviewHistory(stateDir) {
  const historyPath = path.join(stateDir, 'reviewed.json');
  let bytes;
  try {
    bytes = await fs.promises.readFile(historyPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyReviewHistory();
    throw reviewHistoryError(
      'review-history-read-failed',
      'Could not read review history.',
      error,
    );
  }

  let history;
  try {
    history = JSON.parse(decodeUtf8(bytes, 'Review history'));
  } catch (error) {
    throw reviewHistoryError(
      'review-history-invalid',
      'Review history is not valid JSON.',
      error,
    );
  }

  if (!isReviewHistory(history)) {
    throw reviewHistoryError(
      'review-history-invalid',
      'Review history has an unsupported shape.',
    );
  }
  return history;
}

function queueReviewHistoryWrite(stateDir, operation) {
  const previous = reviewHistoryQueues.get(stateDir) || Promise.resolve();
  const current = previous.then(operation, operation);
  const tail = current.then(() => undefined, () => undefined);
  reviewHistoryQueues.set(stateDir, tail);
  tail.then(() => {
    if (reviewHistoryQueues.get(stateDir) === tail) reviewHistoryQueues.delete(stateDir);
  });
  return current;
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function acquireReviewHistoryLock(stateDir) {
  await fs.promises.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(stateDir, '.reviewed.lock');
  const startedAt = Date.now();

  while (true) {
    const nonce = crypto.randomBytes(16).toString('hex');
    let handle;
    try {
      const noFollow = fs.constants.O_NOFOLLOW || 0;
      handle = await fs.promises.open(
        lockPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
        0o600,
      );
      await handle.writeFile(`${nonce}\n`, 'utf8');
      const stats = await handle.stat();
      await handle.close();
      return { lockPath, nonce, dev: stats.dev, ino: stats.ino };
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
        await fs.promises.unlink(lockPath).catch(() => {});
      }
      if (!error || error.code !== 'EEXIST') throw error;
    }

    if (Date.now() - startedAt >= REVIEW_LOCK_TIMEOUT_MS) {
      const error = new Error('Timed out waiting to update review history.');
      error.code = 'review-history-lock-timeout';
      throw error;
    }
    await wait(REVIEW_LOCK_RETRY_MS);
  }
}

async function releaseReviewHistoryLock(lock) {
  let handle;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    handle = await fs.promises.open(lock.lockPath, fs.constants.O_RDONLY | noFollow);
    const stats = await handle.stat();
    if (stats.dev !== lock.dev || stats.ino !== lock.ino) return;
    const owner = await handle.readFile({ encoding: 'utf8' });
    if (owner !== `${lock.nonce}\n`) return;
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }

  // Contenders never remove or replace the lock; they only retry O_EXCL creation.
  // Therefore this verified inode/nonce can only be the lock created by this owner.
  await fs.promises.unlink(lock.lockPath);
}

async function writeReviewHistory(stateDir, history) {
  await fs.promises.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const historyPath = path.join(stateDir, 'reviewed.json');
  const temporaryPath = path.join(
    stateDir,
    `.reviewed.json.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );

  try {
    await fs.promises.writeFile(temporaryPath, `${JSON.stringify(history)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await fs.promises.rename(temporaryPath, historyPath);
  } catch (error) {
    await fs.promises.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function recordReviewedBatch(stateDir, records) {
  const normalizedStateDir = path.resolve(stateDir);
  return queueReviewHistoryWrite(normalizedStateDir, async () => {
    for (const { hash, id, at } of records) {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new TypeError('Invalid memory content hash.');
      if (typeof id !== 'string' || !id) throw new TypeError('Invalid memory card id.');
      if (validIsoDate(at) !== at) throw new TypeError('Invalid review timestamp.');
    }

    const lock = await acquireReviewHistoryLock(normalizedStateDir);
    try {
      const history = await readReviewHistory(normalizedStateDir);
      for (const { hash, id, at } of records) {
        history.entries[hash] = { at, id };
      }

      await writeReviewHistory(normalizedStateDir, history);
    } finally {
      await releaseReviewHistoryLock(lock);
    }
  });
}

function recordReviewed(stateDir, { hash, id, at = new Date().toISOString() } = {}) {
  return recordReviewedBatch(stateDir, [{ hash, id, at }]);
}

async function listProjects(
  root,
  pathCache,
  reviewedEntries = {},
  includeReviewed = false,
  cardTargets,
) {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  const realRoot = await fs.promises.realpath(root);
  const projects = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const projectPath = path.join(root, entry.name);
    const memoryPath = path.join(projectPath, 'memory');
    const expectedRealPath = path.join(realRoot, entry.name, 'memory');
    let memoryEntries;

    const memoryDirectory = await inspectSafeMemoryDirectory(
      memoryPath,
      expectedRealPath,
      realRoot,
    );
    if (!memoryDirectory) continue;

    try {
      memoryEntries = await fs.promises.readdir(memoryPath, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw error;
    }

    const memoryFiles = memoryEntries
      .filter((memory) => (
        memory.isFile()
        && memory.name.endsWith('.md')
        && memory.name !== 'MEMORY.md'
      ))
      .sort((left, right) => compareStrings(left.name, right.name));
    const memoryResults = [];
    for (const memory of memoryFiles) {
      memoryResults.push(await readMemoryCardResult(
        memoryPath,
        entry.name,
        memory.name,
        memoryDirectory,
      ));
    }
    const memoryFileNames = memoryFiles.map((memory) => memory.name);
    const indexHealth = await readIndexHealth(memoryPath, memoryFileNames);
    const unreadable = [
      ...indexHealth.unreadable,
      ...memoryResults.flatMap((result) => (result.unreadable ? [result.unreadable] : [])),
    ].sort((left, right) => compareStrings(left.fileName, right.fileName));

    const realPath = await resolveProjectPath(projectPath, pathCache);
    const pathUnknown = realPath === undefined;
    const readableMemories = memoryResults.filter((result) => result.card);
    const allCards = readableMemories.map((result) => result.card);
    if (cardTargets) {
      for (const result of readableMemories) {
        cardTargets.set(result.card.id, {
          ...result.target,
          card: result.card,
          memoryFileNames,
        });
      }
    }
    const reviewedCount = allCards.reduce((count, card) => (
      count + (Object.prototype.hasOwnProperty.call(reviewedEntries, card.hash) ? 1 : 0)
    ), 0);
    const cards = includeReviewed
      ? allCards.map((card) => ({
        ...card,
        reviewed: Object.prototype.hasOwnProperty.call(reviewedEntries, card.hash),
      }))
      : allCards.filter((card) => !Object.prototype.hasOwnProperty.call(reviewedEntries, card.hash));

    projects.push({
      id: entry.name,
      name: pathUnknown ? entry.name : (path.basename(realPath) || realPath),
      path: pathUnknown ? null : realPath,
      pathUnknown,
      memoryCount: memoryFiles.length,
      unreviewedCount: allCards.length - reviewedCount,
      reviewedCount,
      unindexed: indexHealth.unindexed,
      dangling: indexHealth.dangling,
      unreadable,
      cards,
    });
  }

  return projects.sort((left, right) => compareStrings(left.id, right.id));
}

function decodeInstructionPrefix(bytes) {
  for (let trim = 0; trim <= Math.min(3, bytes.length); trim += 1) {
    try {
      return {
        content: decodeUtf8(bytes.subarray(0, bytes.length - trim), 'Instruction file'),
        trimmed: trim > 0,
      };
    } catch (error) {
      if (error.code !== 'invalid-utf8') throw error;
    }
  }
  return undefined;
}

async function readInstructionFile(filePath, projectId) {
  let handle;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
    const stats = await handle.stat();
    if (!stats.isFile()) return undefined;
    const limit = Math.min(stats.size, MAX_INSTRUCTION_FILE_BYTES);
    const bytes = Buffer.alloc(limit);
    let offset = 0;
    while (offset < limit) {
      const result = await handle.read(bytes, offset, limit - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const decoded = decodeInstructionPrefix(bytes.subarray(0, offset));
    if (!decoded) return undefined;
    return {
      path: filePath,
      projectId,
      content: decoded.content,
      truncated: stats.size > offset || decoded.trimmed,
    };
  } catch {
    return undefined;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function listInstructionFiles(root, projectPathCache) {
  const projects = await listProjects(root, projectPathCache, {}, false);
  const candidates = [{
    path: path.join(path.dirname(root), 'CLAUDE.md'),
    projectId: null,
  }];
  for (const project of projects) {
    if (project.pathUnknown || typeof project.path !== 'string') continue;
    candidates.push(
      { path: path.join(project.path, 'CLAUDE.md'), projectId: project.id },
      { path: path.join(project.path, '.claude', 'CLAUDE.md'), projectId: project.id },
      { path: path.join(project.path, 'CLAUDE.local.md'), projectId: project.id },
    );
  }

  const files = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    const file = await readInstructionFile(candidate.path, candidate.projectId);
    if (file) files.push(file);
  }
  return { files };
}

function decisionResultFields(decision) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    return { id: null, action: null };
  }
  return {
    id: typeof decision.id === 'string' ? decision.id : null,
    action: typeof decision.action === 'string' ? decision.action : null,
  };
}

function safePathSegment(value) {
  return (
    typeof value === 'string'
    && value.length > 0
    && value !== '.'
    && value !== '..'
    && path.basename(value) === value
    && !value.includes('/')
    && !value.includes('\\')
    && !/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/.test(value)
  );
}

async function ensureDirectoryWithoutSymlink(directoryPath, mode) {
  try {
    await fs.promises.mkdir(directoryPath, { mode });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }

  const stats = await fs.promises.lstat(directoryPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    const error = new Error('Unsafe directory target.');
    error.code = 'unsafe-directory';
    throw error;
  }
}

function pathSafeRunName(date = new Date()) {
  return `${date.toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(8).toString('hex')}`;
}

async function createTrashRun(stateDir) {
  await fs.promises.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const trashRoot = path.join(stateDir, 'trash');
  await ensureDirectoryWithoutSymlink(trashRoot, 0o700);

  const [realStateDir, realTrashRoot] = await Promise.all([
    fs.promises.realpath(stateDir),
    fs.promises.realpath(trashRoot),
  ]);
  if (!pathIsWithin(realStateDir, realTrashRoot)) {
    const error = new Error('Unsafe trash directory.');
    error.code = 'unsafe-directory';
    throw error;
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const runName = pathSafeRunName();
    const runPath = path.join(trashRoot, runName);
    try {
      await fs.promises.mkdir(runPath, { mode: 0o700 });
      return {
        trashRoot,
        runName,
        runPath,
        manifestPath: path.join(runPath, 'manifest.json'),
        manifest: { version: 1, items: [] },
      };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
  }

  const error = new Error('Could not allocate a unique trash run.');
  error.code = 'trash-run-collision';
  throw error;
}

async function assertSafeTrashRun(run) {
  const [trashStats, runStats] = await Promise.all([
    fs.promises.lstat(run.trashRoot, { bigint: true }),
    fs.promises.lstat(run.runPath, { bigint: true }),
  ]);
  if (
    trashStats.isSymbolicLink()
    || !trashStats.isDirectory()
    || runStats.isSymbolicLink()
    || !runStats.isDirectory()
    || (run.trashStats && !sameFileIdentity(trashStats, run.trashStats))
    || (run.runStats && !sameFileIdentity(runStats, run.runStats))
  ) {
    const error = new Error('Unsafe trash run.');
    error.code = 'unsafe-directory';
    throw error;
  }

  const [realTrashRoot, realRunPath] = await Promise.all([
    fs.promises.realpath(run.trashRoot),
    fs.promises.realpath(run.runPath),
  ]);
  if (
    !pathIsWithin(realTrashRoot, realRunPath)
    || !sameFilesystemPath(realRunPath, path.join(realTrashRoot, run.runName))
  ) {
    const error = new Error('Unsafe trash run.');
    error.code = 'unsafe-directory';
    throw error;
  }
  return realRunPath;
}

async function acquireApplyLock(stateDir, trustedRealMemoryPath) {
  await fs.promises.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lockDirectory = path.join(stateDir, '.apply-locks');
  await ensureDirectoryWithoutSymlink(lockDirectory, 0o700);
  const lockName = `${crypto.createHash('sha256').update(trustedRealMemoryPath).digest('hex')}.lock`;
  const lockPath = path.join(lockDirectory, lockName);
  const startedAt = Date.now();

  while (true) {
    const nonce = crypto.randomBytes(16).toString('hex');
    let handle;
    try {
      const noFollow = fs.constants.O_NOFOLLOW || 0;
      handle = await fs.promises.open(
        lockPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
        0o600,
      );
      await handle.writeFile(`${nonce}\n`, 'utf8');
      const stats = await handle.stat();
      await handle.close();
      return {
        lockPath,
        lockDirectory,
        nonce,
        dev: stats.dev,
        ino: stats.ino,
      };
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
        await fs.promises.unlink(lockPath).catch(() => {});
      }
      if (error && error.code === 'ENOENT') {
        await ensureDirectoryWithoutSymlink(lockDirectory, 0o700);
        continue;
      }
      if (!error || error.code !== 'EEXIST') throw error;
    }

    if (Date.now() - startedAt >= APPLY_LOCK_TIMEOUT_MS) {
      const error = new Error('Timed out waiting to apply a memory decision.');
      error.code = 'apply-lock-timeout';
      throw error;
    }
    await wait(APPLY_LOCK_RETRY_MS);
  }
}

async function releaseApplyLock(lock) {
  await releaseReviewHistoryLock(lock);
  await fs.promises.rmdir(lock.lockDirectory).catch(() => {});
}

async function atomicWriteFile(filePath, bytes, mode = 0o600) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let handle;

  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    handle = await fs.promises.open(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.chmod(mode & 0o7777);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.promises.rename(temporaryPath, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function findIndexLines(bytes, fileName, memoryFileNames = [fileName]) {
  decodeUtf8(bytes, 'Memory index');
  let offset = 0;
  let fence;
  const matches = [];

  while (offset < bytes.length) {
    let contentEnd = offset;
    while (contentEnd < bytes.length && bytes[contentEnd] !== 0x0a && bytes[contentEnd] !== 0x0d) {
      contentEnd += 1;
    }
    let end = contentEnd;
    if (end < bytes.length && bytes[end] === 0x0d) end += 1;
    if (end < bytes.length && bytes[end] === 0x0a) end += 1;

    const line = decodeUtf8(bytes.subarray(offset, contentEnd), 'Memory index line');
    if (fence) {
      if (closesFence(line, fence)) fence = undefined;
    } else {
      fence = openingFence(line);
      if (!fence) {
        const match = matchIndexLine(line, memoryFileNames);
        if (match && match.target === fileName && isDirectMemoryTarget(match.target)) {
          matches.push({ offset, end, bytes: bytes.subarray(offset, end) });
        }
      }
    }
    offset = end;
  }
  return matches;
}

function removeIndexLines(bytes, lines) {
  const chunks = [];
  let offset = 0;
  for (const line of lines) {
    chunks.push(bytes.subarray(offset, line.offset));
    offset = line.end;
  }
  chunks.push(bytes.subarray(offset));
  return Buffer.concat(chunks);
}

async function readIndexForDelete(indexPath, fileName, memoryFileNames = [fileName]) {
  let listedStats;
  try {
    listedStats = await fs.promises.lstat(indexPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        exists: false,
        bytes: undefined,
        mode: null,
        stats: null,
        line: undefined,
        lines: [],
      };
    }
    throw error;
  }
  if (listedStats.isSymbolicLink() || !listedStats.isFile()) {
    const error = new Error('Unsafe memory index.');
    error.code = 'unsafe-index';
    throw error;
  }

  let handle;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    handle = await fs.promises.open(indexPath, fs.constants.O_RDONLY | noFollow);
    const openedStats = await handle.stat({ bigint: true });
    if (!openedStats.isFile()) {
      const error = new Error('Unsafe memory index.');
      error.code = 'unsafe-index';
      throw error;
    }
    const bytes = await handle.readFile();
    const finalStats = await handle.stat({ bigint: true });
    if (!sameFileVersion(openedStats, finalStats)) {
      const error = new Error('Memory index changed while it was read.');
      error.code = 'changed-index';
      throw error;
    }
    const lines = findIndexLines(bytes, fileName, memoryFileNames);
    return {
      exists: true,
      bytes,
      mode: Number(finalStats.mode & 0o7777n),
      stats: finalStats,
      line: lines[0],
      lines,
    };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function readMemoryForDelete(filePath, expectedHash) {
  let handle;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
    const bytes = await handle.readFile();
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile()) {
      const error = new Error('Unsafe memory file.');
      error.code = 'unsafe-memory-file';
      throw error;
    }
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (hash !== expectedHash) {
      const error = new Error('Memory changed since it was read.');
      error.code = 'changed-since-read';
      throw error;
    }
    return {
      bytes,
      stats,
      mode: Number(stats.mode & 0o7777n),
    };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function assertTrustedMemoryDirectory(target) {
  let listedStats;
  try {
    listedStats = await fs.promises.lstat(target.memoryPath, { bigint: true });
  } catch (error) {
    const unsafe = new Error('The scanned memory directory is no longer available.');
    unsafe.code = 'unsafe-memory-directory';
    unsafe.cause = error;
    throw unsafe;
  }
  if (
    listedStats.isSymbolicLink()
    || !listedStats.isDirectory()
    || listedStats.dev !== target.memoryDev
    || listedStats.ino !== target.memoryIno
  ) {
    const error = new Error('The scanned memory directory changed.');
    error.code = 'unsafe-memory-directory';
    throw error;
  }

  const realMemoryPath = await fs.promises.realpath(target.memoryPath);
  if (
    !pathIsWithin(target.rootRealPath, realMemoryPath)
    || !sameFilesystemPath(realMemoryPath, target.memoryRealPath)
  ) {
    const error = new Error('The scanned memory directory resolved somewhere unexpected.');
    error.code = 'unsafe-memory-directory';
    throw error;
  }

  if (!Number.isInteger(fs.constants.O_DIRECTORY)) return;
  let handle;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    handle = await fs.promises.open(
      target.memoryPath,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | noFollow,
    );
    const openedStats = await handle.stat({ bigint: true });
    if (!openedStats.isDirectory() || !sameFileIdentity(openedStats, listedStats)) {
      const error = new Error('The scanned memory directory changed while it was opened.');
      error.code = 'unsafe-memory-directory';
      throw error;
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function assertTrustedMemoryDirectoryIfAvailable(target) {
  if (target.memoryPath) await assertTrustedMemoryDirectory(target);
}

async function recoverTrustedMemoryTarget(target) {
  try {
    await assertTrustedMemoryDirectory(target);
    return target;
  } catch (originalError) {
    const parentPath = path.dirname(target.memoryPath);
    let realParent;
    let entries;
    try {
      [realParent, entries] = await Promise.all([
        fs.promises.realpath(parentPath),
        fs.promises.readdir(parentPath, { withFileTypes: true }),
      ]);
    } catch {
      throw originalError;
    }
    if (!pathIsWithin(target.rootRealPath, realParent)) throw originalError;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidatePath = path.join(parentPath, entry.name);
      try {
        const stats = await fs.promises.lstat(candidatePath, { bigint: true });
        if (
          stats.isSymbolicLink()
          || !stats.isDirectory()
          || stats.dev !== target.memoryDev
          || stats.ino !== target.memoryIno
        ) continue;
        const realPath = await fs.promises.realpath(candidatePath);
        if (!pathIsWithin(target.rootRealPath, realPath)) continue;
        const recovered = {
          ...target,
          memoryPath: candidatePath,
          memoryRealPath: realPath,
          filePath: path.join(candidatePath, target.fileName),
          indexPath: path.join(candidatePath, 'MEMORY.md'),
        };
        await assertTrustedMemoryDirectory(recovered);
        return recovered;
      } catch {
        // Keep looking for the exact scanned directory inode.
      }
    }
    throw originalError;
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileVersion(left, right) {
  return (
    sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
  );
}

function sameIndexSnapshot(left, right) {
  if (left.exists !== right.exists) return false;
  if (!left.exists) return true;
  return sameFileVersion(left.stats, right.stats) && left.bytes.equals(right.bytes);
}

async function lstatRegularFile(filePath) {
  const stats = await fs.promises.lstat(filePath, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isFile()) {
    const error = new Error('Unsafe memory file.');
    error.code = 'unsafe-memory-file';
    throw error;
  }
  return stats;
}

async function unlinkIfSameFile(filePath, expectedStats) {
  try {
    const stats = await fs.promises.lstat(filePath, { bigint: true });
    if (!stats.isSymbolicLink() && stats.isFile() && sameFileIdentity(stats, expectedStats)) {
      await fs.promises.unlink(filePath);
      return true;
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') return true;
  }
  return false;
}

async function hashOpenFile(filePath) {
  let handle;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
    const bytes = await handle.readFile();
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile()) throw new Error('Path is not a regular file.');
    return {
      hash: crypto.createHash('sha256').update(bytes).digest('hex'),
      stats,
    };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function sourceMoveIsPreserved(sourcePath, sourceStats, expectedHash) {
  try {
    const currentSource = await hashOpenFile(sourcePath);
    return sameFileIdentity(currentSource.stats, sourceStats) && currentSource.hash === expectedHash;
  } catch {
    return false;
  }
}

function incompleteMoveError(
  originalError,
  destinationPath,
  destinationStats,
  source,
  sourcePreserved,
) {
  const error = new Error('Could not prove cleanup of an incomplete memory move.', {
    cause: originalError,
  });
  error.code = 'move-cleanup-incomplete';
  error.partialMove = {
    path: destinationPath,
    stats: destinationStats,
    mode: source.mode,
    sourcePreserved,
  };
  return error;
}

async function moveFileNoReplace(
  sourcePath,
  destinationPath,
  source,
  expectedHash,
  {
    beforeSourceUnlink = async () => {},
    linkFile = fs.promises.link,
    unlinkDestination = unlinkIfSameFile,
  } = {},
) {
  const currentSourceStats = await lstatRegularFile(sourcePath);
  if (!sameFileVersion(currentSourceStats, source.stats)) {
    const error = new Error('Memory changed before it could be moved.');
    error.code = 'changed-since-read';
    throw error;
  }

  let linked = false;
  try {
    await linkFile(sourcePath, destinationPath);
    linked = true;
  } catch (error) {
    if (!error || error.code !== 'EXDEV') throw error;
  }

  if (linked) {
    let linkedStats;
    try {
      linkedStats = await lstatRegularFile(destinationPath);
      if (!sameFileIdentity(linkedStats, source.stats)) {
        const error = new Error('Memory changed before it could be moved.');
        error.code = 'changed-since-read';
        throw error;
      }
      const destination = await hashOpenFile(destinationPath);
      if (
        destination.hash !== expectedHash
        || !sameFileIdentity(destination.stats, linkedStats)
      ) {
        const error = new Error('Memory changed before it could be moved.');
        error.code = 'changed-since-read';
        throw error;
      }
      await beforeSourceUnlink({ destinationPath, destinationStats: destination.stats });
      const sourceBeforeUnlink = await lstatRegularFile(sourcePath);
      if (!sameFileVersion(sourceBeforeUnlink, destination.stats)) {
        const error = new Error('Memory path changed before it could be moved.');
        error.code = 'changed-since-read';
        throw error;
      }
      await fs.promises.unlink(sourcePath);
      return { stats: destination.stats, mode: source.mode, sourceRemoved: true };
    } catch (error) {
      const destinationStats = linkedStats || source.stats;
      const sourcePreserved = await sourceMoveIsPreserved(
        sourcePath,
        source.stats,
        expectedHash,
      );
      if (!sourcePreserved) {
        throw incompleteMoveError(
          error,
          destinationPath,
          destinationStats,
          source,
          false,
        );
      }
      if (await unlinkDestination(destinationPath, destinationStats)) throw error;
      throw incompleteMoveError(
        error,
        destinationPath,
        destinationStats,
        source,
        true,
      );
    }
  }

  const temporaryPath = path.join(
    path.dirname(destinationPath),
    `.scmd-move.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let sourceHandle;
  let destinationHandle;
  let temporaryStats;
  let destinationStats;
  let destinationLinked = false;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    sourceHandle = await fs.promises.open(sourcePath, fs.constants.O_RDONLY | noFollow);
    const sourceBytes = await sourceHandle.readFile();
    const reopenedStats = await sourceHandle.stat({ bigint: true });
    if (
      !reopenedStats.isFile()
      || !sameFileVersion(reopenedStats, source.stats)
      || crypto.createHash('sha256').update(sourceBytes).digest('hex') !== expectedHash
    ) {
      const error = new Error('Memory changed before it could be copied.');
      error.code = 'changed-since-read';
      throw error;
    }
    destinationHandle = await fs.promises.open(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    await destinationHandle.writeFile(sourceBytes);
    await destinationHandle.chmod(source.mode & 0o7777);
    await destinationHandle.sync();
    temporaryStats = await destinationHandle.stat({ bigint: true });
    await destinationHandle.close();
    destinationHandle = undefined;
    await sourceHandle.close();
    sourceHandle = undefined;
    await linkFile(temporaryPath, destinationPath);
    destinationLinked = true;
    destinationStats = await lstatRegularFile(destinationPath);
    if (!sameFileIdentity(destinationStats, temporaryStats)) {
      throw new Error('Could not verify copied trash file.');
    }
    await fs.promises.unlink(temporaryPath);
    await beforeSourceUnlink({ destinationPath, destinationStats });
    const sourceBeforeUnlink = await lstatRegularFile(sourcePath);
    if (!sameFileVersion(sourceBeforeUnlink, source.stats)) {
      const error = new Error('Memory path changed before it could be removed.');
      error.code = 'changed-since-read';
      throw error;
    }
    await fs.promises.unlink(sourcePath);
    return { stats: destinationStats, mode: source.mode, sourceRemoved: true };
  } catch (error) {
    if (destinationHandle) await destinationHandle.close().catch(() => {});
    if (sourceHandle) await sourceHandle.close().catch(() => {});
    await fs.promises.unlink(temporaryPath).catch(() => {});
    const copiedStats = destinationLinked ? (destinationStats || temporaryStats) : undefined;
    if (!copiedStats) throw error;
    const sourcePreserved = await sourceMoveIsPreserved(
      sourcePath,
      source.stats,
      expectedHash,
    );
    if (!sourcePreserved) {
      throw incompleteMoveError(
        error,
        destinationPath,
        copiedStats,
        source,
        false,
      );
    }
    if (await unlinkDestination(destinationPath, copiedStats)) throw error;
    throw incompleteMoveError(
      error,
      destinationPath,
      copiedStats,
      source,
      true,
    );
  }
}

async function writeTrashManifest(run, manifest = run.manifest) {
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  await atomicWriteFile(run.manifestPath, bytes, 0o600);
}

async function cleanEmptyTrashRun(run, projectTrashPath) {
  if (projectTrashPath) await fs.promises.rmdir(projectTrashPath).catch(() => {});
  if (!run || run.manifest.items.length > 0) return false;
  await fs.promises.unlink(run.manifestPath).catch(() => {});
  let runRemoved = false;
  try {
    await fs.promises.rmdir(run.runPath);
    runRemoved = true;
  } catch (error) {
    if (error && error.code === 'ENOENT') runRemoved = true;
  }
  if (runRemoved) await fs.promises.rmdir(run.trashRoot).catch(() => {});
  return runRemoved;
}

async function trashRunRemainsReusable(run, previousItemCount) {
  if (!run || run.manifest.items.length !== previousItemCount || previousItemCount === 0) {
    return false;
  }
  try {
    await assertSafeTrashRun(run);
    await writeTrashManifest(run);
    return true;
  } catch {
    return false;
  }
}

function updateManifestIndex(manifestItem, index) {
  manifestItem.indexLine = index.line ? index.line.bytes.toString('utf8') : null;
  manifestItem.indexLines = index.lines.map((line) => ({
    line: line.bytes.toString('utf8'),
    offset: line.offset,
  }));
  manifestItem.indexOffset = index.line ? index.line.offset : null;
  manifestItem.indexMode = index.exists ? index.mode : null;
  manifestItem.indexAfterDeleteExists = index.exists;
  manifestItem.indexAfterDeleteHash = index.exists
    ? crypto.createHash('sha256').update(removeIndexLines(index.bytes, index.lines)).digest('hex')
    : null;
}

function restoreBaseMatchesIndex(item, index) {
  if (!item.indexRestoreGroup || item.indexRestoreBaseExists !== index.exists) return false;
  if (!index.exists) return item.indexRestoreBaseHash === null && item.indexRestoreBaseMode === null;
  return (
    item.indexRestoreBaseMode === index.mode
    && /^[a-f0-9]{64}$/.test(item.indexRestoreBaseHash)
    && crypto.createHash('sha256').update(index.bytes).digest('hex') === item.indexRestoreBaseHash
  );
}

function prepareIndexRestoreGroup(run, manifestItem, index) {
  const priorItem = [...run.manifest.items].reverse().find((item) => (
    item !== manifestItem
    && item.projectId === manifestItem.projectId
    && item.status === 'deleted'
    && restoreBaseMatchesIndex(item, index)
    && Array.isArray(item.indexRestoreLines)
  ));
  const group = priorItem?.indexRestoreGroup || crypto.randomBytes(16).toString('hex');
  const priorLines = run.manifest.items
    .filter((item) => item !== manifestItem && item.indexRestoreGroup === group)
    .flatMap((item) => item.indexRestoreLines || [])
    .map((line) => ({ ...line, byteLength: Buffer.byteLength(line.line) }))
    .sort((left, right) => left.offset - right.offset);

  manifestItem.indexRestoreGroup = group;
  manifestItem.indexRestoreLines = manifestItem.indexLines.map((line) => {
    let offset = line.offset;
    for (const priorLine of priorLines) {
      if (priorLine.offset <= offset) offset += priorLine.byteLength;
    }
    return { line: line.line, offset };
  });
  manifestItem.indexRestoreBaseExists = manifestItem.indexAfterDeleteExists;
  manifestItem.indexRestoreBaseHash = manifestItem.indexAfterDeleteHash;
  manifestItem.indexRestoreBaseMode = manifestItem.indexMode;
}

function advanceIndexRestoreBase(run, manifestItem) {
  const changes = [];
  for (const item of run.manifest.items) {
    if (item.indexRestoreGroup !== manifestItem.indexRestoreGroup) continue;
    changes.push({
      item,
      exists: item.indexRestoreBaseExists,
      hash: item.indexRestoreBaseHash,
      mode: item.indexRestoreBaseMode,
    });
    item.indexRestoreBaseExists = manifestItem.indexAfterDeleteExists;
    item.indexRestoreBaseHash = manifestItem.indexAfterDeleteHash;
    item.indexRestoreBaseMode = manifestItem.indexMode;
  }
  return () => {
    for (const change of changes) {
      change.item.indexRestoreBaseExists = change.exists;
      change.item.indexRestoreBaseHash = change.hash;
      change.item.indexRestoreBaseMode = change.mode;
    }
  };
}

async function atomicRewriteIndexIfUnchanged(
  target,
  expectedIndex,
  bytes,
  {
    beforeCommit = async () => {},
    afterCommit = async () => {},
  } = {},
) {
  const directory = path.dirname(target.indexPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(target.indexPath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let handle;
  let replacementStats;
  try {
    await assertTrustedMemoryDirectoryIfAvailable(target);
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    handle = await fs.promises.open(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.chmod((expectedIndex.mode ?? 0o600) & 0o7777);
    await handle.sync();
    replacementStats = await handle.stat({ bigint: true });
    await handle.close();
    handle = undefined;

    await assertTrustedMemoryDirectoryIfAvailable(target);
    await beforeCommit();
    const currentIndex = await readIndexForDelete(
      target.indexPath,
      target.fileName,
      target.memoryFileNames,
    );
    if (!sameIndexSnapshot(expectedIndex, currentIndex)) {
      await fs.promises.unlink(temporaryPath);
      return { replaced: false, currentIndex };
    }
    await assertTrustedMemoryDirectoryIfAvailable(target);
    await beforeCommit();
    if (expectedIndex.exists) {
      await fs.promises.rename(temporaryPath, target.indexPath);
    } else {
      try {
        await fs.promises.link(temporaryPath, target.indexPath);
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error;
        await assertTrustedMemoryDirectoryIfAvailable(target);
        const currentIndex = await readIndexForDelete(
          target.indexPath,
          target.fileName,
          target.memoryFileNames,
        );
        await fs.promises.unlink(temporaryPath);
        return { replaced: false, currentIndex };
      }
      await fs.promises.unlink(temporaryPath).catch(() => {});
    }
    const committedIndex = {
      exists: true,
      bytes,
      mode: expectedIndex.mode ?? 0o600,
      stats: replacementStats,
      line: undefined,
      lines: [],
    };
    try {
      await assertTrustedMemoryDirectoryIfAvailable(target);
      await afterCommit(committedIndex);
    } catch (error) {
      error.indexCommit = { before: expectedIndex, after: committedIndex };
      throw error;
    }
    return { replaced: true, committedIndex };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function rollbackCommittedIndex(target, indexCommit) {
  await assertTrustedMemoryDirectoryIfAvailable(target);
  const current = await readIndexForDelete(
    target.indexPath,
    target.fileName,
    target.memoryFileNames,
  );
  if (
    !current.exists
    || !sameFileIdentity(current.stats, indexCommit.after.stats)
    || !current.bytes.equals(indexCommit.after.bytes)
  ) return false;

  if (!indexCommit.before.exists) {
    await assertTrustedMemoryDirectoryIfAvailable(target);
    return unlinkIfSameFile(target.indexPath, current.stats);
  }
  const replacement = await atomicRewriteIndexIfUnchanged(
    target,
    current,
    indexCommit.before.bytes,
  );
  return replacement.replaced;
}

function singleLine(value, fallback) {
  const normalized = typeof value === 'string'
    ? value.replace(/[\r\n\u2028\u2029]+/g, ' ').trim()
    : '';
  return normalized || fallback;
}

function indexTitle(value, fileName) {
  return singleLine(value, path.basename(fileName, path.extname(fileName)))
    .replace(/([\\\[\]])/g, '\\$1');
}

function indexTarget(fileName, memoryFileNames = [fileName]) {
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, (character) => (
    `%${character.codePointAt(0).toString(16).toUpperCase()}`
  ));
  const siblings = memoryFileNames instanceof Set
    ? memoryFileNames
    : new Set(memoryFileNames || [fileName]);
  return encoded !== fileName && siblings.has(encoded)
    ? encoded.replace(/%/g, '\\%')
    : encoded;
}

function replaceIndexHooks(bytes, lines, hook) {
  const replacementHook = Buffer.from(singleLine(hook, 'Untitled memory'));
  const chunks = [];
  let offset = 0;

  for (const line of lines) {
    const lineBytes = bytes.subarray(line.offset, line.end);
    let contentLength = lineBytes.length;
    if (contentLength > 0 && lineBytes[contentLength - 1] === 0x0a) contentLength -= 1;
    if (contentLength > 0 && lineBytes[contentLength - 1] === 0x0d) contentLength -= 1;
    const content = decodeUtf8(lineBytes.subarray(0, contentLength), 'Memory index line');
    const link = matchIndexLine(content);
    const separatorAt = link ? content.indexOf(' — ', link.raw.length) : -1;
    const prefix = Buffer.from(separatorAt >= 0
      ? content.slice(0, separatorAt + 3)
      : `${content} — `);
    chunks.push(bytes.subarray(offset, line.offset), prefix, replacementHook);
    chunks.push(lineBytes.subarray(contentLength));
    offset = line.end;
  }

  chunks.push(bytes.subarray(offset));
  return Buffer.concat(chunks);
}

function appendIndexLine(bytes, name, fileName, hook, memoryFileNames) {
  const chunks = [bytes];
  if (
    bytes.length > 0
    && bytes[bytes.length - 1] !== 0x0a
    && bytes[bytes.length - 1] !== 0x0d
  ) chunks.push(Buffer.from('\n'));
  chunks.push(Buffer.from(
    `- [${indexTitle(name, fileName)}](${indexTarget(fileName, memoryFileNames)}) — ${singleLine(hook, 'Untitled memory')}\n`,
  ));
  return Buffer.concat(chunks);
}

async function rewriteIndexForEdit(
  target,
  name,
  hook,
  updateExisting,
  {
    guardMemory = async () => {},
    afterVerifiedIndexRead = async () => {},
    afterIndexCommit = async () => {},
  } = {},
) {
  await assertTrustedMemoryDirectoryIfAvailable(target);
  await guardMemory();
  let candidate = await readIndexForDelete(
    target.indexPath,
    target.fileName,
    target.memoryFileNames,
  );
  for (let attempt = 0; attempt < 16; attempt += 1) {
    await assertTrustedMemoryDirectoryIfAvailable(target);
    await guardMemory();
    const verified = await readIndexForDelete(
      target.indexPath,
      target.fileName,
      target.memoryFileNames,
    );
    if (!sameIndexSnapshot(candidate, verified)) {
      candidate = verified;
      continue;
    }
    await afterVerifiedIndexRead(verified);
    if (verified.lines.length > 0 && !updateExisting) {
      await guardMemory();
      return;
    }
    const replacementBytes = verified.lines.length > 0
      ? replaceIndexHooks(verified.bytes, verified.lines, hook)
      : appendIndexLine(
        verified.bytes || Buffer.alloc(0),
        name,
        target.fileName,
        hook,
        target.memoryFileNames,
      );
    const replacement = await atomicRewriteIndexIfUnchanged(
      target,
      verified,
      replacementBytes,
      {
        beforeCommit: guardMemory,
        afterCommit: async () => {
          await afterIndexCommit();
          await guardMemory();
        },
      },
    );
    if (replacement.replaced) return;
    candidate = replacement.currentIndex;
  }

  const error = new Error('Memory index kept changing during edit.');
  error.code = 'changed-index';
  throw error;
}

async function atomicRewriteMemoryIfUnchanged(
  target,
  source,
  expectedHash,
  bytes,
  { afterRename = async () => {} } = {},
) {
  const temporaryPath = path.join(
    target.memoryPath,
    `.scmd-edit.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let handle;
  let replacementStats;
  let committedMemory;
  try {
    await assertTrustedMemoryDirectory(target);
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    handle = await fs.promises.open(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.chmod(source.mode & 0o7777);
    await handle.sync();
    replacementStats = await handle.stat({ bigint: true });
    await handle.close();
    handle = undefined;

    await assertTrustedMemoryDirectory(target);
    const current = await readMemoryForDelete(target.filePath, expectedHash);
    if (!sameFileIdentity(source.stats, current.stats)) {
      const error = new Error('Memory changed before it could be edited.');
      error.code = 'changed-since-read';
      throw error;
    }
    await assertTrustedMemoryDirectory(target);
    await fs.promises.rename(temporaryPath, target.filePath);
    committedMemory = {
      bytes,
      stats: replacementStats,
      mode: source.mode,
    };
    await afterRename();
    return committedMemory;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temporaryPath).catch(() => {});
    if (committedMemory) error.committedMemory = committedMemory;
    throw error;
  }
}

function memoryDescription(bytes) {
  const text = decodeUtf8(bytes, 'Memory file');
  const { top } = splitFrontmatter(text);
  return firstValue(top.description);
}

async function assertProposedMemory(target, edited, expectedHash) {
  await assertTrustedMemoryDirectory(target);
  const current = await readMemoryForDelete(target.filePath, expectedHash);
  if (!sameFileIdentity(current.stats, edited.stats)) {
    const error = new Error('Memory path changed after the edit was committed.');
    error.code = 'changed-since-read';
    throw error;
  }
}

async function applyEdit(
  target,
  stateDir,
  expectedHash,
  newContent,
  {
    afterMemoryRename = async () => {},
    afterMemoryCommitValidated = async () => {},
    afterVerifiedIndexRead = async () => {},
    afterIndexCommit = async () => {},
  } = {},
) {
  if (!safePathSegment(target.projectId) || !safePathSegment(target.fileName)) {
    throw new Error('Unsafe scanned memory target.');
  }
  if (typeof newContent !== 'string') {
    const error = new Error('Edit content must be a string.');
    error.code = 'invalid-new-content';
    throw error;
  }

  const newBytes = Buffer.from(newContent);
  const lock = await acquireApplyLock(stateDir, target.memoryRealPath);
  try {
    await assertTrustedMemoryDirectory(target);
    const source = await readMemoryForDelete(target.filePath, expectedHash);
    const newCard = createMemoryCard({
      projectId: target.projectId,
      fileName: target.fileName,
      bytes: newBytes,
      mtime: new Date(),
    });
    const descriptionChanged = memoryDescription(source.bytes) !== memoryDescription(newBytes);
    let edited;
    try {
      edited = await atomicRewriteMemoryIfUnchanged(
        target,
        source,
        expectedHash,
        newBytes,
        { afterRename: afterMemoryRename },
      );
      await assertProposedMemory(target, edited, newCard.hash);
      await afterMemoryCommitValidated();
      await rewriteIndexForEdit(
        target,
        newCard.name,
        newCard.summary,
        descriptionChanged,
        {
          guardMemory: () => assertProposedMemory(target, edited, newCard.hash),
          afterVerifiedIndexRead,
          afterIndexCommit,
        },
      );
    } catch (error) {
      edited ||= error.committedMemory;
      if (!edited) throw error;
      let rollbackTarget;
      try {
        rollbackTarget = await recoverTrustedMemoryTarget(target);
        if (error.indexCommit) {
          const restored = await rollbackCommittedIndex(rollbackTarget, error.indexCommit);
          if (!restored) throw new Error('The committed index changed before rollback.');
        }
        await atomicRewriteMemoryIfUnchanged(
          rollbackTarget,
          edited,
          newCard.hash,
          source.bytes,
        );
      } catch (rollbackError) {
        if (rollbackError && rollbackError.code === 'changed-since-read') throw error;
        const incomplete = new Error('Could not roll back an incomplete memory edit.', {
          cause: rollbackError,
        });
        incomplete.code = 'edit-rollback-incomplete';
        throw incomplete;
      }
      throw error;
    }
  } finally {
    await releaseApplyLock(lock);
  }
}

async function rewriteIndexForDelete(
  target,
  initialIndex,
  persistSnapshot = async () => {},
  guardSource = async () => {},
) {
  let candidate = initialIndex;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    await assertTrustedMemoryDirectoryIfAvailable(target);
    await guardSource();
    await persistSnapshot(candidate);
    const verified = await readIndexForDelete(
      target.indexPath,
      target.fileName,
      target.memoryFileNames,
    );
    if (!sameIndexSnapshot(candidate, verified)) {
      candidate = verified;
      continue;
    }
    if (verified.lines.length === 0) return { changed: false, index: verified };
    const replacement = await atomicRewriteIndexIfUnchanged(
      target,
      verified,
      removeIndexLines(verified.bytes, verified.lines),
      {
        beforeCommit: guardSource,
        afterCommit: guardSource,
      },
    );
    if (replacement.replaced) return { changed: true, index: verified };
    candidate = replacement.currentIndex;
  }

  const error = new Error('Memory index kept changing during delete.');
  error.code = 'changed-index';
  throw error;
}

async function assertMemorySourceAbsent(target) {
  await assertTrustedMemoryDirectory(target);
  try {
    await fs.promises.lstat(target.filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  const error = new Error('A memory reappeared after the reviewed file was moved.');
  error.code = 'memory-recreated';
  throw error;
}

async function restoreIndexLines(target, originalIndex) {
  if (originalIndex.lines.length === 0) return;
  const savedLines = originalIndex.lines.map((line) => ({
    ...line,
    end: line.end ?? line.offset + line.bytes.length,
  }));
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const currentIndex = await readIndexForDelete(
      target.indexPath,
      target.fileName,
      target.memoryFileNames,
    );
    if (!currentIndex.exists) throw new Error('Memory index disappeared during rollback.');

    const usedCurrentLines = new Set();
    const unmatchedSavedLines = [];
    for (const savedLine of savedLines) {
      const exactIndex = currentIndex.lines.findIndex((currentLine, index) => (
        !usedCurrentLines.has(index) && currentLine.bytes.equals(savedLine.bytes)
      ));
      if (exactIndex >= 0) {
        usedCurrentLines.add(exactIndex);
      } else {
        unmatchedSavedLines.push(savedLine);
      }
    }
    const missing = [];
    for (const savedLine of unmatchedSavedLines) {
      const equivalentIndex = currentIndex.lines.findIndex((unused, index) => (
        !usedCurrentLines.has(index)
      ));
      if (equivalentIndex >= 0) {
        usedCurrentLines.add(equivalentIndex);
      } else {
        missing.push(savedLine);
      }
    }
    if (missing.length === 0) return;

    let restored;
    if (originalIndex.bytes && missing.length === savedLines.length) {
      const withoutLines = removeIndexLines(originalIndex.bytes, savedLines);
      let anchorOffset = -1;
      if (
        withoutLines.length > 0
        && currentIndex.bytes.length >= withoutLines.length
        && currentIndex.bytes.subarray(0, withoutLines.length).equals(withoutLines)
      ) {
        anchorOffset = 0;
      } else if (
        withoutLines.length > 0
        && currentIndex.bytes.length >= withoutLines.length
        && currentIndex.bytes
          .subarray(currentIndex.bytes.length - withoutLines.length)
          .equals(withoutLines)
      ) {
        anchorOffset = currentIndex.bytes.length - withoutLines.length;
      } else if (withoutLines.length > 0 && withoutLines.length <= 16 * 1024 * 1024) {
        const foundAt = currentIndex.bytes.indexOf(withoutLines);
        if (foundAt >= 0 && foundAt === currentIndex.bytes.lastIndexOf(withoutLines)) {
          anchorOffset = foundAt;
        }
      }
      if (anchorOffset >= 0) {
        restored = Buffer.concat([
          currentIndex.bytes.subarray(0, anchorOffset),
          originalIndex.bytes,
          currentIndex.bytes.subarray(anchorOffset + withoutLines.length),
        ]);
      }
    }

    if (!restored) {
      restored = currentIndex.bytes;
      for (const line of missing) {
        if (
          restored.length > 0
          && restored[restored.length - 1] !== 0x0a
          && restored[restored.length - 1] !== 0x0d
        ) {
          restored = Buffer.concat([restored, Buffer.from('\n')]);
        }
        restored = Buffer.concat([restored, line.bytes]);
      }
    }

    const replacement = await atomicRewriteIndexIfUnchanged(target, currentIndex, restored);
    if (replacement.replaced) return;
  }

  const error = new Error('Memory index kept changing during rollback.');
  error.code = 'changed-index';
  throw error;
}

async function removeManifestItemAfterRollback(run, manifestItem) {
  const remainingItems = run.manifest.items.filter((item) => item !== manifestItem);
  const nextManifest = { ...run.manifest, items: remainingItems };
  try {
    if (remainingItems.length > 0) {
      await writeTrashManifest(run, nextManifest);
    } else {
      await fs.promises.unlink(run.manifestPath);
    }
    run.manifest = nextManifest;
  } catch {
    // A durable pending record is safe to retain after a completed rollback.
  }
}

async function applyDelete(
  target,
  run,
  deletedAt,
  stateDir,
  expectedHash,
  {
    moveFile = moveFileNoReplace,
    cleanupFile = unlinkIfSameFile,
    afterFinalManifestCommit = async () => {},
  } = {},
) {
  if (!safePathSegment(target.projectId) || !safePathSegment(target.fileName)) {
    throw new Error('Unsafe scanned memory target.');
  }

  const lock = await acquireApplyLock(stateDir, target.memoryRealPath);
  try {
    await assertTrustedMemoryDirectory(target);
    const source = await readMemoryForDelete(target.filePath, expectedHash);
    const fileMode = source.mode;
    const index = await readIndexForDelete(
      target.indexPath,
      target.fileName,
      target.memoryFileNames,
    );
    const realRunPath = await assertSafeTrashRun(run);
    const projectTrashPath = path.join(run.runPath, target.projectId);
    await ensureDirectoryWithoutSymlink(projectTrashPath, 0o700);
    const realProjectTrashPath = await fs.promises.realpath(projectTrashPath);
    if (!sameFilesystemPath(realProjectTrashPath, path.join(realRunPath, target.projectId))) {
      await cleanEmptyTrashRun(run, projectTrashPath);
      const error = new Error('Unsafe trash project directory.');
      error.code = 'unsafe-directory';
      throw error;
    }
    const destinationPath = path.join(projectTrashPath, target.fileName);
    try {
      await fs.promises.lstat(destinationPath);
      throw new Error('Trash destination already exists.');
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        await cleanEmptyTrashRun(run, projectTrashPath);
        throw error;
      }
    }

    const manifestItem = {
      status: 'pending',
      id: target.card.id,
      hash: expectedHash,
      from: target.filePath,
      to: destinationPath,
      deletedAt,
      fileMode,
      projectId: target.projectId,
      fileName: target.fileName,
      name: target.card.name,
      summary: target.card.summary,
    };
    updateManifestIndex(manifestItem, index);
    prepareIndexRestoreGroup(run, manifestItem, index);
    run.manifest.items.push(manifestItem);
    try {
      await writeTrashManifest(run);
    } catch (error) {
      run.manifest.items.pop();
      await cleanEmptyTrashRun(run, projectTrashPath);
      throw error;
    }

    let moved;
    let indexChanged = false;
    let rollbackIndex = index;
    let restorePreviousGroupBase;
    try {
      moved = await moveFile(target.filePath, destinationPath, source, expectedHash);

      let persistedIndex = index;
      const rewrite = await rewriteIndexForDelete(target, index, async (currentIndex) => {
        if (sameIndexSnapshot(persistedIndex, currentIndex)) return;
        updateManifestIndex(manifestItem, currentIndex);
        prepareIndexRestoreGroup(run, manifestItem, currentIndex);
        await writeTrashManifest(run);
        persistedIndex = currentIndex;
      }, () => assertMemorySourceAbsent(target));
      rollbackIndex = rewrite.index;
      indexChanged = rewrite.changed;

      manifestItem.status = 'deleted';
      restorePreviousGroupBase = advanceIndexRestoreBase(run, manifestItem);
      await writeTrashManifest(run);
      await afterFinalManifestCommit();
      await assertMemorySourceAbsent(target);
    } catch (error) {
      if (!moved && error && error.partialMove) moved = error.partialMove;
      if (restorePreviousGroupBase) restorePreviousGroupBase();
      manifestItem.status = 'pending';
      const rollbackErrors = [];
      let rollbackTarget = target;
      try {
        rollbackTarget = await recoverTrustedMemoryTarget(target);
      } catch (cause) {
        rollbackErrors.push(cause);
      }
      if (error.indexCommit && rollbackErrors.length === 0) {
        try {
          if (!await rollbackCommittedIndex(rollbackTarget, error.indexCommit)) {
            throw new Error('The committed index changed before rollback.');
          }
        } catch (cause) {
          rollbackErrors.push(cause);
        }
      }
      if (indexChanged && rollbackErrors.length === 0) {
        try {
          await restoreIndexLines(rollbackTarget, rollbackIndex);
        } catch (cause) {
          rollbackErrors.push(cause);
        }
      }
      if (moved && rollbackErrors.length === 0) {
        if (moved.sourcePreserved) {
          if (!await cleanupFile(destinationPath, moved.stats)) rollbackErrors.push(error);
        } else {
          try {
            const trashSource = await readMemoryForDelete(destinationPath, expectedHash);
            await moveFile(destinationPath, rollbackTarget.filePath, trashSource, expectedHash);
          } catch (cause) {
            rollbackErrors.push(cause);
          }
        }
      }

      if (rollbackErrors.length === 0) {
        await removeManifestItemAfterRollback(run, manifestItem);
        await cleanEmptyTrashRun(run, projectTrashPath);
      } else {
        manifestItem.status = 'rollback-incomplete';
        await writeTrashManifest(run).catch(() => {});
      }
      throw rollbackErrors[0] || error;
    }
  } finally {
    await releaseApplyLock(lock);
  }
}

function trashError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

async function inspectTrashRoot(stateDir) {
  const trashRoot = path.join(stateDir, 'trash');
  let stats;
  try {
    stats = await fs.promises.lstat(trashRoot, { bigint: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined;
    throw trashError('invalid-trash-root', 'Could not inspect the trash directory.', error);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw trashError('invalid-trash-root', 'The trash directory is unsafe.');
  }

  let realStateDir;
  let realTrashRoot;
  try {
    [realStateDir, realTrashRoot] = await Promise.all([
      fs.promises.realpath(stateDir),
      fs.promises.realpath(trashRoot),
    ]);
  } catch (error) {
    throw trashError('invalid-trash-root', 'Could not resolve the trash directory.', error);
  }
  if (
    !pathIsWithin(realStateDir, realTrashRoot)
    || !sameFilesystemPath(realTrashRoot, path.join(realStateDir, 'trash'))
  ) throw trashError('invalid-trash-root', 'The trash directory resolved somewhere unexpected.');

  return { trashRoot, realTrashRoot, trashStats: stats };
}

async function readBoundedJsonFile(filePath, subject) {
  let handle;
  try {
    const listedStats = await fs.promises.lstat(filePath, { bigint: true });
    if (listedStats.isSymbolicLink() || !listedStats.isFile()) {
      throw trashError('invalid-manifest', `${subject} is not a regular file.`);
    }
    if (listedStats.size > BigInt(MAX_TRASH_MANIFEST_BYTES)) {
      throw trashError('invalid-manifest', `${subject} is too large.`);
    }
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
    const openedStats = await handle.stat({ bigint: true });
    if (!openedStats.isFile() || !sameFileIdentity(openedStats, listedStats)) {
      throw trashError('invalid-manifest', `${subject} changed while it was opened.`);
    }
    const bytes = await handle.readFile();
    const finalStats = await handle.stat({ bigint: true });
    if (!sameFileVersion(openedStats, finalStats)) {
      throw trashError('invalid-manifest', `${subject} changed while it was read.`);
    }
    let value;
    try {
      value = JSON.parse(decodeUtf8(bytes, subject));
    } catch (error) {
      throw trashError('invalid-manifest', `${subject} is not valid JSON.`, error);
    }
    return { value, bytes, stats: finalStats };
  } catch (error) {
    if (error && error.code === 'invalid-manifest') throw error;
    throw trashError('invalid-manifest', `Could not read ${subject.toLowerCase()}.`, error);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function validManifestMode(value, nullable = false) {
  return (nullable && value === null)
    || (Number.isInteger(value) && value >= 0 && value <= 0o7777);
}

function savedManifestLines(item) {
  let records;
  if (Array.isArray(item.indexLines)) {
    records = item.indexLines;
  } else if (item.indexLine === null) {
    records = [];
  } else {
    records = [{ line: item.indexLine, offset: item.indexOffset }];
  }
  if (records.length > 10_000) return undefined;

  const lines = [];
  let previousEnd = -1;
  for (const record of records) {
    if (
      !record
      || typeof record !== 'object'
      || Array.isArray(record)
      || typeof record.line !== 'string'
      || !Number.isSafeInteger(record.offset)
      || record.offset < 0
    ) return undefined;
    const bytes = Buffer.from(record.line);
    if (bytes.length === 0 || bytes.length > MAX_TRASH_MANIFEST_BYTES) return undefined;
    const matches = findIndexLines(bytes, item.fileName, [item.fileName]);
    if (matches.length !== 1 || matches[0].offset !== 0 || matches[0].end !== bytes.length) {
      return undefined;
    }
    if (record.offset < previousEnd) return undefined;
    previousEnd = record.offset + bytes.length;
    lines.push({ bytes, offset: record.offset, end: record.offset + bytes.length });
  }
  return lines;
}

function validatedIndexRestoreMetadata(item, indexLines) {
  const fields = [
    item.indexRestoreGroup,
    item.indexRestoreLines,
    item.indexRestoreBaseExists,
    item.indexRestoreBaseHash,
    item.indexRestoreBaseMode,
  ];
  if (fields.every((value) => value === undefined)) return {};
  if (
    !/^[a-f0-9]{32}$/.test(item.indexRestoreGroup)
    || !Array.isArray(item.indexRestoreLines)
    || item.indexRestoreLines.length !== indexLines.length
    || typeof item.indexRestoreBaseExists !== 'boolean'
    || !validManifestMode(item.indexRestoreBaseMode, true)
  ) return undefined;
  if (
    (item.indexRestoreBaseExists && (
      !/^[a-f0-9]{64}$/.test(item.indexRestoreBaseHash)
      || item.indexRestoreBaseMode === null
    ))
    || (!item.indexRestoreBaseExists && (
      item.indexRestoreBaseHash !== null
      || item.indexRestoreBaseMode !== null
    ))
  ) return undefined;

  const lines = [];
  let previousEnd = -1;
  for (let index = 0; index < item.indexRestoreLines.length; index += 1) {
    const record = item.indexRestoreLines[index];
    if (
      !record
      || typeof record !== 'object'
      || Array.isArray(record)
      || record.line !== indexLines[index].bytes.toString('utf8')
      || !Number.isSafeInteger(record.offset)
      || record.offset < 0
    ) return undefined;
    const bytes = Buffer.from(record.line);
    if (record.offset < previousEnd) return undefined;
    previousEnd = record.offset + bytes.length;
    lines.push({ bytes, offset: record.offset, end: record.offset + bytes.length });
  }
  return { group: item.indexRestoreGroup, lines };
}

function validateTrashManifestItem(item, root, runPath) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
  if (
    !safePathSegment(item.projectId)
    || !safePathSegment(item.fileName)
    || !item.fileName.endsWith('.md')
    || item.fileName === 'MEMORY.md'
    || item.id !== `${item.projectId}/${item.fileName}`
    || !/^[a-f0-9]{64}$/.test(item.hash)
    || validIsoDate(item.deletedAt) !== item.deletedAt
    || !['deleted', 'pending', 'rollback-incomplete', 'restore-pending', 'restore-incomplete', 'restored']
      .includes(item.status)
    || !validManifestMode(item.fileMode)
    || !validManifestMode(item.indexMode, true)
    || !(item.indexLine === null || typeof item.indexLine === 'string')
    || !(item.indexOffset === null || (Number.isSafeInteger(item.indexOffset) && item.indexOffset >= 0))
    || (item.status === 'restored' && validIsoDate(item.restoredAt) !== item.restoredAt)
  ) return undefined;

  const sourcePath = path.join(root, item.projectId, 'memory', item.fileName);
  const trashPath = path.join(runPath, item.projectId, item.fileName);
  if (
    typeof item.from !== 'string'
    || typeof item.to !== 'string'
    || !sameFilesystemPath(path.resolve(item.from), sourcePath)
    || !sameFilesystemPath(path.resolve(item.to), trashPath)
    || !sameFilesystemPath(item.from, sourcePath)
    || !sameFilesystemPath(item.to, trashPath)
  ) return undefined;

  const indexLines = savedManifestLines(item);
  if (!indexLines) return undefined;
  if (
    (indexLines.length === 0 && (item.indexLine !== null || item.indexOffset !== null))
    || (indexLines.length > 0 && (
      item.indexLine !== indexLines[0].bytes.toString('utf8')
      || item.indexOffset !== indexLines[0].offset
      || item.indexMode === null
    ))
  ) return undefined;
  if (
    !(
      item.indexAfterDeleteHash === undefined
      || item.indexAfterDeleteHash === null
      || /^[a-f0-9]{64}$/.test(item.indexAfterDeleteHash)
    )
    || !(
      item.indexAfterDeleteExists === undefined
      || typeof item.indexAfterDeleteExists === 'boolean'
    )
  ) return undefined;
  if (item.indexAfterDeleteExists === false && (
    item.indexAfterDeleteHash !== null
    || item.indexMode !== null
    || indexLines.length !== 0
  )) return undefined;
  if (item.indexAfterDeleteExists === true && (
    !/^[a-f0-9]{64}$/.test(item.indexAfterDeleteHash)
    || item.indexMode === null
  )) return undefined;

  const restoreMetadata = validatedIndexRestoreMetadata(item, indexLines);
  if (!restoreMetadata) return undefined;

  return { item, sourcePath, trashPath, indexLines, restoreMetadata };
}

async function readTrashRun(root, stateDir, runId) {
  if (!safePathSegment(runId)) throw trashError('unknown-run', 'Unknown trash run.');
  const trash = await inspectTrashRoot(stateDir);
  if (!trash) throw trashError('unknown-run', 'Unknown trash run.');
  const runPath = path.join(trash.trashRoot, runId);
  let runStats;
  try {
    runStats = await fs.promises.lstat(runPath, { bigint: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') throw trashError('unknown-run', 'Unknown trash run.');
    throw trashError('invalid-manifest', 'Could not inspect the trash run.', error);
  }
  if (runStats.isSymbolicLink() || !runStats.isDirectory()) {
    throw trashError('invalid-manifest', 'The trash run is unsafe.');
  }
  const realRunPath = await fs.promises.realpath(runPath).catch((error) => {
    throw trashError('invalid-manifest', 'Could not resolve the trash run.', error);
  });
  if (
    !pathIsWithin(trash.realTrashRoot, realRunPath)
    || !sameFilesystemPath(realRunPath, path.join(trash.realTrashRoot, runId))
  ) throw trashError('invalid-manifest', 'The trash run resolved somewhere unexpected.');

  const manifestPath = path.join(runPath, 'manifest.json');
  const read = await readBoundedJsonFile(manifestPath, 'Trash manifest');
  const manifest = read.value;
  if (
    !manifest
    || typeof manifest !== 'object'
    || Array.isArray(manifest)
    || manifest.version !== 1
    || !Array.isArray(manifest.items)
    || manifest.items.length > MAX_APPLY_DECISIONS
  ) throw trashError('invalid-manifest', 'Trash manifest has an unsupported shape.');

  const counts = new Map();
  for (const item of manifest.items) {
    if (item && typeof item.id === 'string') counts.set(item.id, (counts.get(item.id) || 0) + 1);
  }
  const items = manifest.items.map((item, index) => {
    const validated = validateTrashManifestItem(item, root, runPath);
    return {
      index,
      raw: item,
      validated: validated && counts.get(item.id) === 1 ? validated : undefined,
    };
  });
  const restoreGroups = new Map();
  for (const entry of items) {
    const group = entry.validated?.restoreMetadata.group;
    if (!group) continue;
    if (!restoreGroups.has(group)) restoreGroups.set(group, []);
    restoreGroups.get(group).push(entry);
  }
  for (const entries of restoreGroups.values()) {
    const first = entries[0].validated.item;
    const coherent = entries.every(({ validated }) => (
      validated.item.projectId === first.projectId
      && validated.item.indexRestoreBaseExists === first.indexRestoreBaseExists
      && validated.item.indexRestoreBaseHash === first.indexRestoreBaseHash
      && validated.item.indexRestoreBaseMode === first.indexRestoreBaseMode
    ));
    const lines = entries
      .flatMap(({ validated }) => validated.restoreMetadata.lines)
      .sort((left, right) => left.offset - right.offset);
    let previousEnd = -1;
    const nonOverlapping = lines.every((line) => {
      if (line.offset < previousEnd) return false;
      previousEnd = line.offset + line.bytes.length;
      return true;
    });
    if (!coherent || !nonOverlapping) {
      for (const entry of entries) entry.validated = undefined;
    }
  }
  return {
    ...trash,
    runId,
    runName: runId,
    runPath,
    realRunPath,
    runStats,
    manifestPath,
    manifest,
    manifestBytes: read.bytes,
    items,
  };
}

function publicTrashItem(entry) {
  if (!entry.validated) {
    return {
      id: null,
      projectId: null,
      fileName: null,
      name: null,
      summary: null,
      hash: null,
      deletedAt: null,
      status: 'invalid',
      restorable: false,
    };
  }
  const item = entry.raw && typeof entry.raw === 'object' && !Array.isArray(entry.raw)
    ? entry.raw
    : {};
  return {
    id: typeof item.id === 'string' ? item.id : null,
    projectId: safePathSegment(item.projectId) ? item.projectId : null,
    fileName: safePathSegment(item.fileName) ? item.fileName : null,
    name: typeof item.name === 'string' ? item.name : null,
    summary: typeof item.summary === 'string' ? item.summary : null,
    hash: /^[a-f0-9]{64}$/.test(item.hash) ? item.hash : null,
    deletedAt: validIsoDate(item.deletedAt) === item.deletedAt ? item.deletedAt : null,
    status: entry.validated ? item.status : 'invalid',
    restorable: Boolean(entry.validated && item.status === 'deleted'),
  };
}

async function trashRunSize(run) {
  let size = run.manifestBytes.length;
  const visited = new Set();
  for (const entry of run.items) {
    if (!entry.validated || visited.has(entry.validated.trashPath)) continue;
    visited.add(entry.validated.trashPath);
    try {
      const stats = await fs.promises.lstat(entry.validated.trashPath);
      if (!stats.isSymbolicLink() && stats.isFile()) size += stats.size;
    } catch {
      // Missing or unreadable item files are reported when a restore is attempted.
    }
  }
  return size;
}

async function listTrashRuns(root, stateDir) {
  let trash;
  try {
    trash = await inspectTrashRoot(stateDir);
  } catch {
    return { runs: [], notices: ['Trash could not be read.'] };
  }
  if (!trash) return { runs: [], notices: [] };

  let entries;
  try {
    entries = await fs.promises.readdir(trash.trashRoot, { withFileTypes: true });
  } catch {
    return { runs: [], notices: ['Trash could not be read.'] };
  }
  const runs = [];
  let invalid = false;
  for (const entry of entries.sort((left, right) => compareStrings(right.name, left.name))) {
    if (!safePathSegment(entry.name)) continue;
    try {
      const run = await readTrashRun(root, stateDir, entry.name);
      const publicItems = run.items.map(publicTrashItem);
      const deletedAt = publicItems
        .map((item) => item.deletedAt)
        .filter(Boolean)
        .sort(compareStrings)
        .at(-1) || null;
      runs.push({
        id: entry.name,
        deletedAt,
        size: await trashRunSize(run),
        status: 'ready',
        items: publicItems,
      });
    } catch {
      invalid = true;
      runs.push({
        id: entry.name,
        deletedAt: null,
        size: 0,
        status: 'invalid',
        items: [],
      });
    }
  }
  runs.sort((left, right) => (
    compareStrings(right.deletedAt || '', left.deletedAt || '')
    || compareStrings(right.id, left.id)
  ));
  return { runs, notices: invalid ? ['Some trash runs could not be read.'] : [] };
}

async function assertSafeTrashItemPath(run, validated) {
  await assertSafeTrashRun(run);
  const projectTrashPath = path.join(run.runPath, validated.item.projectId);
  let stats;
  try {
    stats = await fs.promises.lstat(projectTrashPath);
  } catch (error) {
    throw trashError('changed-in-trash', 'The trashed memory is missing.', error);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw trashError('unsafe-trash-item', 'The trashed memory path is unsafe.');
  }
  const realProjectPath = await fs.promises.realpath(projectTrashPath);
  if (!sameFilesystemPath(realProjectPath, path.join(run.realRunPath, validated.item.projectId))) {
    throw trashError('unsafe-trash-item', 'The trashed memory path resolved somewhere unexpected.');
  }
}

async function buildRestoreTarget(root, item) {
  const realRoot = await fs.promises.realpath(root);
  const memoryPath = path.join(root, item.projectId, 'memory');
  const memoryDirectory = await inspectSafeMemoryDirectory(
    memoryPath,
    path.join(realRoot, item.projectId, 'memory'),
    realRoot,
  );
  if (!memoryDirectory) throw trashError('unsafe-destination', 'The memory directory is unsafe.');

  let entries;
  try {
    entries = await fs.promises.readdir(memoryPath, { withFileTypes: true });
  } catch (error) {
    throw trashError('unsafe-destination', 'Could not inspect the memory directory.', error);
  }
  const memoryFileNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'MEMORY.md')
    .map((entry) => entry.name);
  if (!memoryFileNames.includes(item.fileName)) memoryFileNames.push(item.fileName);
  return {
    projectId: item.projectId,
    fileName: item.fileName,
    memoryPath,
    memoryRealPath: memoryDirectory.realPath,
    rootRealPath: memoryDirectory.rootRealPath,
    memoryDev: memoryDirectory.stats.dev,
    memoryIno: memoryDirectory.stats.ino,
    filePath: path.join(memoryPath, item.fileName),
    indexPath: path.join(memoryPath, 'MEMORY.md'),
    memoryFileNames,
  };
}

function indexMatchesPostDeleteSnapshot(index, item) {
  if (typeof item.indexAfterDeleteExists !== 'boolean') return false;
  if (item.indexAfterDeleteExists !== index.exists) return false;
  if (!index.exists) return item.indexAfterDeleteHash === null;
  return (
    /^[a-f0-9]{64}$/.test(item.indexAfterDeleteHash)
    && crypto.createHash('sha256').update(index.bytes).digest('hex') === item.indexAfterDeleteHash
    && index.mode === item.indexMode
  );
}

function insertSavedLinesAtOriginalOffsets(bytes, lines) {
  let restored = bytes;
  for (const line of lines) {
    if (line.offset > restored.length) return undefined;
    if (
      line.offset > 0
      && restored[line.offset - 1] !== 0x0a
      && restored[line.offset - 1] !== 0x0d
    ) return undefined;
    restored = Buffer.concat([
      restored.subarray(0, line.offset),
      line.bytes,
      restored.subarray(line.offset),
    ]);
  }
  return restored;
}

function missingSavedIndexLines(index, savedLines) {
  const usedCurrentLines = new Set();
  const unmatchedSavedLines = [];
  for (const savedLine of savedLines) {
    const exactIndex = index.lines.findIndex((currentLine, currentIndex) => (
      !usedCurrentLines.has(currentIndex) && currentLine.bytes.equals(savedLine.bytes)
    ));
    if (exactIndex >= 0) {
      usedCurrentLines.add(exactIndex);
    } else {
      unmatchedSavedLines.push(savedLine);
    }
  }

  const missing = [];
  for (const savedLine of unmatchedSavedLines) {
    const equivalentIndex = index.lines.findIndex((unused, currentIndex) => (
      !usedCurrentLines.has(currentIndex)
    ));
    if (equivalentIndex >= 0) {
      usedCurrentLines.add(equivalentIndex);
    } else {
      missing.push(savedLine);
    }
  }
  return missing;
}

function appendMissingSavedLines(index, missingLines) {
  let bytes = index.bytes || Buffer.alloc(0);
  for (const line of missingLines) {
    if (
      bytes.length > 0
      && bytes[bytes.length - 1] !== 0x0a
      && bytes[bytes.length - 1] !== 0x0d
    ) bytes = Buffer.concat([bytes, Buffer.from('\n')]);
    bytes = Buffer.concat([bytes, line.bytes]);
  }
  return bytes;
}

function restoreGroupIndexBytes(index, target, item, groupEntries) {
  if (!item.indexRestoreGroup || !index.exists) return undefined;
  const currentEntry = groupEntries.find((entry) => entry.validated?.item === item);
  if (!currentEntry) return undefined;
  const availableFileNames = new Set([
    ...target.memoryFileNames,
    ...groupEntries.map((entry) => entry.validated.item.fileName),
  ]);
  const present = new Set();
  const removedLines = [];

  for (const entry of groupEntries) {
    if (entry.raw.status !== 'restored') continue;
    const currentLines = findIndexLines(
      index.bytes,
      entry.validated.item.fileName,
      availableFileNames,
    );
    const used = new Set();
    for (let lineIndex = 0; lineIndex < entry.validated.restoreMetadata.lines.length; lineIndex += 1) {
      const savedLine = entry.validated.restoreMetadata.lines[lineIndex];
      const matchIndex = currentLines.findIndex((line, currentIndex) => (
        !used.has(currentIndex) && line.bytes.equals(savedLine.bytes)
      ));
      if (matchIndex < 0) return undefined;
      used.add(matchIndex);
      removedLines.push(currentLines[matchIndex]);
      present.add(`${entry.index}:${lineIndex}`);
    }
  }

  removedLines.sort((left, right) => left.offset - right.offset);
  const normalized = removeIndexLines(index.bytes, removedLines);
  if (
    item.indexRestoreBaseExists !== true
    || index.mode !== item.indexRestoreBaseMode
    || crypto.createHash('sha256').update(normalized).digest('hex') !== item.indexRestoreBaseHash
  ) return undefined;

  const allLines = groupEntries.flatMap((entry) => (
    entry.validated.restoreMetadata.lines.map((line, lineIndex) => ({
      entry,
      line,
      lineIndex,
    }))
  ));
  const adjustedLines = currentEntry.validated.restoreMetadata.lines.map((line) => {
    let offset = line.offset;
    for (const candidate of allLines) {
      if (candidate.line.offset >= line.offset || candidate.entry === currentEntry) continue;
      if (!present.has(`${candidate.entry.index}:${candidate.lineIndex}`)) {
        offset -= candidate.line.bytes.length;
      }
    }
    if (offset < 0) return undefined;
    return { ...line, offset, end: offset + line.bytes.length };
  });
  if (adjustedLines.some((line) => !line)) return undefined;
  return insertSavedLinesAtOriginalOffsets(index.bytes, adjustedLines);
}

async function assertRestoredMemory(target, moved, expectedHash) {
  await assertTrustedMemoryDirectory(target);
  const current = await readMemoryForDelete(target.filePath, expectedHash);
  if (!sameFileIdentity(current.stats, moved.stats)) {
    throw trashError('changed-since-read', 'The restored memory changed.');
  }
}

async function restoreManifestIndex(target, item, savedLines, guardMemory, groupEntries = []) {
  if (savedLines.length === 0) return { changed: false };
  let candidate = await readIndexForDelete(
    target.indexPath,
    target.fileName,
    target.memoryFileNames,
  );
  for (let attempt = 0; attempt < 16; attempt += 1) {
    await guardMemory();
    const verified = await readIndexForDelete(
      target.indexPath,
      target.fileName,
      target.memoryFileNames,
    );
    if (!sameIndexSnapshot(candidate, verified)) {
      candidate = verified;
      continue;
    }
    const missingLines = missingSavedIndexLines(verified, savedLines);
    if (missingLines.length === 0) return { changed: false };

    let replacementBytes;
    replacementBytes = restoreGroupIndexBytes(verified, target, item, groupEntries);
    if (indexMatchesPostDeleteSnapshot(verified, item) && verified.lines.length === 0) {
      replacementBytes ||= insertSavedLinesAtOriginalOffsets(
        verified.bytes || Buffer.alloc(0),
        savedLines,
      );
    }
    replacementBytes ||= appendMissingSavedLines(verified, missingLines);
    const expectedIndex = verified.exists
      ? verified
      : { ...verified, mode: item.indexMode ?? 0o600 };
    const replacement = await atomicRewriteIndexIfUnchanged(
      target,
      expectedIndex,
      replacementBytes,
      { beforeCommit: guardMemory, afterCommit: guardMemory },
    );
    if (replacement.replaced) {
      return {
        changed: true,
        indexCommit: { before: verified, after: replacement.committedIndex },
      };
    }
    candidate = replacement.currentIndex;
  }
  throw trashError('changed-index', 'Memory index kept changing during restore.');
}

async function destinationIsAbsent(target) {
  await assertTrustedMemoryDirectory(target);
  try {
    await fs.promises.lstat(target.filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  throw trashError('destination-exists', 'A memory already exists at the restore destination.');
}

function clearRestoreFields(item, status) {
  item.status = status;
  delete item.restoreStartedAt;
  delete item.restoredAt;
}

async function writeValidatedTrashManifest(run) {
  await assertSafeTrashRun(run);
  await writeTrashManifest(run);
}

async function restoreDeletedItem(root, stateDir, run, entry) {
  const { item, trashPath } = entry.validated;
  const target = await buildRestoreTarget(root, item);
  const projectLock = await acquireApplyLock(stateDir, target.memoryRealPath);
  try {
    await assertTrustedMemoryDirectory(target);
    await assertSafeTrashItemPath(run, entry.validated);
    const trashSource = await readMemoryForDelete(trashPath, item.hash).catch((error) => {
      if (error && error.code === 'changed-since-read') {
        throw trashError('changed-in-trash', 'The trashed memory changed.', error);
      }
      throw error;
    });
    if (trashSource.mode !== item.fileMode) {
      throw trashError('changed-in-trash', 'The trashed memory mode changed.');
    }
    await destinationIsAbsent(target);
    await readIndexForDelete(target.indexPath, target.fileName, target.memoryFileNames);

    item.status = 'restore-pending';
    item.restoreStartedAt = new Date().toISOString();
    await writeValidatedTrashManifest(run);

    let moved;
    let indexCommit;
    try {
      moved = await moveFileNoReplace(trashPath, target.filePath, trashSource, item.hash);
      const guardMemory = () => assertRestoredMemory(target, moved, item.hash);
      const groupEntries = item.indexRestoreGroup
        ? run.items.filter((candidate) => (
          candidate.validated?.item.indexRestoreGroup === item.indexRestoreGroup
        ))
        : [];
      const indexResult = await restoreManifestIndex(
        target,
        item,
        entry.validated.indexLines,
        guardMemory,
        groupEntries,
      );
      indexCommit = indexResult.indexCommit;
      await guardMemory();
      item.status = 'restored';
      item.restoredAt = new Date().toISOString();
      delete item.restoreStartedAt;
      await writeValidatedTrashManifest(run);
      return;
    } catch (error) {
      if (!moved && error && error.partialMove) moved = error.partialMove;
      if (!indexCommit && error && error.indexCommit) indexCommit = error.indexCommit;
      const rollbackErrors = [];
      if (indexCommit) {
        try {
          if (!await rollbackCommittedIndex(target, indexCommit)) {
            throw new Error('The restored index changed before rollback.');
          }
        } catch (cause) {
          rollbackErrors.push(cause);
        }
      }
      if (moved && rollbackErrors.length === 0) {
        if (moved.sourcePreserved) {
          if (!await unlinkIfSameFile(target.filePath, moved.stats)) rollbackErrors.push(error);
        } else {
          try {
            await assertSafeTrashItemPath(run, entry.validated);
            const restoredSource = await readMemoryForDelete(target.filePath, item.hash);
            await moveFileNoReplace(target.filePath, trashPath, restoredSource, item.hash);
          } catch (cause) {
            rollbackErrors.push(cause);
          }
        }
      }

      if (rollbackErrors.length === 0) {
        clearRestoreFields(item, 'deleted');
        await writeValidatedTrashManifest(run).catch(() => {});
      } else {
        clearRestoreFields(item, 'restore-incomplete');
        await writeValidatedTrashManifest(run).catch(() => {});
        throw trashError(
          'restore-incomplete',
          'Could not roll back an incomplete restore.',
          rollbackErrors[0],
        );
      }
      throw error;
    }
  } finally {
    await releaseApplyLock(projectLock);
  }
}

function restoreResult(runId, id, status, reason) {
  return {
    runId: typeof runId === 'string' ? runId : null,
    id: typeof id === 'string' ? id : null,
    status,
    ...(reason ? { reason } : {}),
  };
}

async function restoreTrashItem(root, stateDir, runId, id) {
  if (!safePathSegment(runId) || typeof id !== 'string' || id.length === 0) {
    return restoreResult(runId, id, 'error', 'invalid-selection');
  }
  let initialRun;
  try {
    initialRun = await readTrashRun(root, stateDir, runId);
  } catch (error) {
    return restoreResult(
      runId,
      id,
      'error',
      error && error.code === 'unknown-run' ? 'unknown-run' : 'invalid-manifest',
    );
  }

  const runLock = await acquireApplyLock(stateDir, `trash:${initialRun.realRunPath}`);
  try {
    let run;
    try {
      run = await readTrashRun(root, stateDir, runId);
    } catch (error) {
      return restoreResult(
        runId,
        id,
        'error',
        error && error.code === 'unknown-run' ? 'unknown-run' : 'invalid-manifest',
      );
    }
    if (
      !sameFileIdentity(initialRun.trashStats, run.trashStats)
      || !sameFileIdentity(initialRun.runStats, run.runStats)
    ) return restoreResult(runId, id, 'error', 'invalid-manifest');
    const matches = run.items.filter((entry) => entry.raw && entry.raw.id === id);
    if (matches.length === 0) return restoreResult(runId, id, 'error', 'unknown-item');
    if (matches.length !== 1 || !matches[0].validated) {
      return restoreResult(runId, id, 'error', 'invalid-manifest-item');
    }
    const entry = matches[0];
    if (entry.raw.status === 'restored') {
      return restoreResult(runId, id, 'skipped', 'already-restored');
    }
    if (entry.raw.status !== 'deleted') {
      return restoreResult(runId, id, 'error', 'not-restorable');
    }

    try {
      await restoreDeletedItem(root, stateDir, run, entry);
      return restoreResult(runId, id, 'restored');
    } catch (error) {
      if (error && error.code === 'changed-in-trash') {
        return restoreResult(runId, id, 'skipped', 'changed-in-trash');
      }
      const known = [
        'destination-exists',
        'unsafe-index',
        'unsafe-destination',
        'unsafe-trash-item',
        'restore-incomplete',
      ];
      return restoreResult(
        runId,
        id,
        'error',
        known.includes(error && error.code) ? error.code : 'restore-failed',
      );
    }
  } finally {
    await releaseApplyLock(runLock);
  }
}

function purgeResult(runId, status, reason) {
  return {
    runId: typeof runId === 'string' ? runId : null,
    status,
    ...(reason ? { reason } : {}),
  };
}

async function purgeTrashRun(root, stateDir, runId) {
  if (!safePathSegment(runId)) return purgeResult(runId, 'error', 'invalid-selection');
  let initialRun;
  try {
    initialRun = await readTrashRun(root, stateDir, runId);
  } catch (error) {
    return purgeResult(
      runId,
      'error',
      error && error.code === 'unknown-run' ? 'unknown-run' : 'invalid-manifest',
    );
  }

  const runLock = await acquireApplyLock(stateDir, `trash:${initialRun.realRunPath}`);
  let quarantinePath;
  try {
    let run;
    try {
      run = await readTrashRun(root, stateDir, runId);
    } catch (error) {
      return purgeResult(
        runId,
        'error',
        error && error.code === 'unknown-run' ? 'unknown-run' : 'invalid-manifest',
      );
    }
    if (
      !sameFileIdentity(initialRun.trashStats, run.trashStats)
      || !sameFileIdentity(initialRun.runStats, run.runStats)
    ) return purgeResult(runId, 'error', 'invalid-manifest');
    await assertSafeTrashRun(run);

    quarantinePath = path.join(
      run.trashRoot,
      `.purge-${crypto.randomBytes(16).toString('hex')}`,
    );
    await fs.promises.rename(run.runPath, quarantinePath);
    const quarantineStats = await fs.promises.lstat(quarantinePath, { bigint: true });
    const quarantineRealPath = await fs.promises.realpath(quarantinePath);
    if (
      quarantineStats.isSymbolicLink()
      || !quarantineStats.isDirectory()
      || !sameFileIdentity(run.runStats, quarantineStats)
      || !sameFilesystemPath(
        quarantineRealPath,
        path.join(run.realTrashRoot, path.basename(quarantinePath)),
      )
    ) throw trashError('purge-failed', 'The trash run changed before it could be purged.');
    await fs.promises.rm(quarantinePath, { recursive: true, force: false });
    quarantinePath = undefined;
    await fs.promises.rmdir(run.trashRoot).catch(() => {});
    return purgeResult(runId, 'purged');
  } catch {
    if (quarantinePath) {
      await fs.promises.rename(
        quarantinePath,
        path.join(initialRun.trashRoot, runId),
      ).catch(() => {});
    }
    return purgeResult(runId, 'error', 'purge-failed');
  } finally {
    await releaseApplyLock(runLock);
  }
}

async function applyDecisions(
  root,
  stateDir,
  projectPathCache,
  decisions,
  onAppliedTransition = () => {},
) {
  const cardTargets = new Map();
  await listProjects(root, projectPathCache, {}, true, cardTargets);

  const results = [];
  const pendingKeeps = [];
  const appliedAt = new Date().toISOString();
  let trashRun;
  let trashRunLock;

  try {
    for (const decision of decisions) {
    const fields = decisionResultFields(decision);
    const resultIndex = results.length;

    if (
      !decision
      || typeof decision !== 'object'
      || Array.isArray(decision)
      || typeof decision.id !== 'string'
      || decision.id.length === 0
      || typeof decision.action !== 'string'
    ) {
      results.push({ ...fields, status: 'error', reason: 'invalid-decision' });
      continue;
    }

    if (!['keep', 'delete', 'edit'].includes(decision.action)) {
      results.push({ ...fields, status: 'error', reason: 'unsupported-action' });
      continue;
    }

    const hasNewContent = Object.prototype.hasOwnProperty.call(decision, 'newContent');
    if (decision.action === 'edit' && (!hasNewContent || typeof decision.newContent !== 'string')) {
      results.push({ ...fields, status: 'error', reason: 'invalid-new-content' });
      continue;
    }

    if (decision.action !== 'edit' && hasNewContent) {
      results.push({ ...fields, status: 'error', reason: 'new-content-not-allowed' });
      continue;
    }

    if (!/^[a-f0-9]{64}$/.test(decision.expectedHash)) {
      results.push({ ...fields, status: 'error', reason: 'invalid-expected-hash' });
      continue;
    }

    const target = cardTargets.get(decision.id);
    if (!target) {
      results.push({ ...fields, status: 'error', reason: 'unknown-id' });
      continue;
    }

    if (target.card.hash !== decision.expectedHash) {
      results.push({ ...fields, status: 'skipped', reason: 'changed-since-read' });
      continue;
    }

    if (decision.action === 'delete') {
      let previousTrashItemCount = 0;
      try {
        if (!trashRun) {
          trashRun = await createTrashRun(stateDir);
          const realRunPath = await assertSafeTrashRun(trashRun);
          trashRunLock = await acquireApplyLock(stateDir, `trash:${realRunPath}`);
        }
        previousTrashItemCount = trashRun.manifest.items.length;
        await applyDelete(target, trashRun, appliedAt, stateDir, decision.expectedHash);
        results.push({ ...fields, status: 'applied' });
        onAppliedTransition({ type: 'removed', id: target.card.id });
      } catch (error) {
        const failedRun = trashRun;
        if (!await trashRunRemainsReusable(failedRun, previousTrashItemCount)) {
          trashRun = undefined;
          if (failedRun) await cleanEmptyTrashRun(failedRun);
          if (trashRunLock) {
            await releaseApplyLock(trashRunLock);
            trashRunLock = undefined;
          }
        }
        if (error && error.code === 'changed-since-read') {
          results.push({ ...fields, status: 'skipped', reason: 'changed-since-read' });
        } else {
          results.push({ ...fields, status: 'error', reason: 'delete-failed' });
        }
      }
      continue;
    }

    if (decision.action === 'edit') {
      try {
        await applyEdit(
          target,
          stateDir,
          decision.expectedHash,
          decision.newContent,
        );
        results.push({ ...fields, status: 'applied' });
        onAppliedTransition({
          type: 'changed',
          id: target.card.id,
          hash: crypto.createHash('sha256').update(decision.newContent).digest('hex'),
        });
      } catch (error) {
        if (error && error.code === 'changed-since-read') {
          results.push({ ...fields, status: 'skipped', reason: 'changed-since-read' });
        } else {
          results.push({ ...fields, status: 'error', reason: 'edit-failed' });
        }
      }
      continue;
    }

    results.push({ ...fields, status: 'pending' });
    pendingKeeps.push({
      resultIndex,
      record: { hash: target.card.hash, id: target.card.id, at: appliedAt },
    });
    }

    if (pendingKeeps.length > 0) {
      try {
        await recordReviewedBatch(stateDir, pendingKeeps.map(({ record }) => record));
        for (const { resultIndex } of pendingKeeps) results[resultIndex].status = 'applied';
      } catch (error) {
        const reason = ['review-history-invalid', 'review-history-read-failed'].includes(error.code)
          ? 'review-history-unavailable'
          : 'review-history-write-failed';
        for (const { resultIndex } of pendingKeeps) {
          results[resultIndex].status = 'error';
          results[resultIndex].reason = reason;
        }
      }
    }

    return results;
  } finally {
    if (trashRunLock) await releaseApplyLock(trashRunLock);
  }
}

function browserCommand(platform, url) {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'linux') return { command: 'xdg-open', args: [url] };
  if (platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'start', '""', url],
      windowsVerbatimArguments: true,
    };
  }
}

function rewriteError(code, message, cause) {
  const error = new Error(message, { cause });
  error.code = code;
  return error;
}

function buildRewritePrompt(content, instruction) {
  return [
    'Rewrite the Claude Code memory file below according to the user instruction.',
    'Return only the complete new memory file, including its YAML frontmatter.',
    'Do not wrap the output in Markdown or code fences.',
    'Preserve the existing `name` and `type` exactly.',
    'Update `description` only if needed to accurately describe the rewritten content.',
    '',
    'User instruction:',
    instruction,
    '',
    'Complete memory file:',
    content,
  ].join('\n');
}

function claudeEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => (
    !CLAUDE_NESTING_ENV.has(name)
  )));
}

function claudeFailureDetail(stderr, stdout, code, signal) {
  const output = stderr.trim() || stdout.trim();
  if (output) {
    try {
      const parsed = JSON.parse(output);
      if (parsed && typeof parsed === 'object' && typeof parsed.result === 'string') {
        return parsed.result.trim() || output;
      }
    } catch {
      // Plain-text CLI errors are already useful as written.
    }
    return output;
  }
  return `exit code ${code}${signal ? ` (${signal})` : ''}`;
}

function terminateClaudeChild(child, launch = {}, { spawnSyncImpl = spawnSync } = {}) {
  if (launch.treeKillCommand && Number.isInteger(child.pid) && child.pid > 0) {
    try {
      const result = spawnSyncImpl(
        launch.treeKillCommand,
        ['/PID', String(child.pid), '/T', '/F'],
        { shell: false, stdio: 'ignore', windowsHide: true },
      );
      if (result && !result.error && result.status === 0) return;
    } catch {
      // Fall through to killing the direct child if taskkill is unavailable.
    }
  }

  try {
    child.kill('SIGKILL');
  } catch {
    // The process may have exited between the state check and the signal.
  }
}

function terminateActiveRewrites(activeChildren, launch, options) {
  for (const child of activeChildren) terminateClaudeChild(child, launch, options);
}

function runClaudeInvocation(prompt, args, {
  spawnImpl,
  env,
  timeoutMs,
  capability,
  activeChildren,
  maxOutputBytes,
  isExecutable,
  spawnSyncImpl,
}) {
  return new Promise((resolveInvocation, rejectInvocation) => {
    let child;
    let settled = false;
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timeout;

    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      operation(value);
    };

    const launch = capability.launch || { command: 'claude', argsPrefix: [] };
    if (launch.shimPath && !isExecutable(launch.shimPath)) {
      capability.rewriteAvailable = false;
      rejectInvocation(rewriteError(
        'rewrite-unavailable',
        'Claude Code is not installed or is not available on PATH.',
      ));
      return;
    }

    try {
      child = spawnImpl(launch.command, [...launch.argsPrefix, ...args], {
        env: claudeEnvironment(env),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (cause) {
      if (cause && cause.code === 'ENOENT') {
        capability.rewriteAvailable = false;
        rejectInvocation(rewriteError(
          'rewrite-unavailable',
          'Claude Code is not installed or is not available on PATH.',
          cause,
        ));
        return;
      }
      rejectInvocation(rewriteError('rewrite-failed', `Could not start Claude Code: ${cause.message}`, cause));
      return;
    }

    activeChildren.add(child);

    timeout = setTimeout(() => {
      terminateClaudeChild(child, launch, { spawnSyncImpl });
      finish(rejectInvocation, rewriteError(
        'rewrite-timeout',
        `Claude Code rewrite timed out after ${timeoutMs} ms.`,
      ));
    }, timeoutMs);

    const capture = (streamName) => (chunk) => {
      if (settled) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) {
        terminateClaudeChild(child, launch, { spawnSyncImpl });
        finish(rejectInvocation, rewriteError(
          'rewrite-output-too-large',
          'Claude Code produced too much output.',
        ));
        return;
      }
      if (streamName === 'stdout') stdout += chunk;
      else stderr += chunk;
    };

    child.stdout.on('data', capture('stdout'));
    child.stderr.on('data', capture('stderr'));
    child.once('error', (cause) => {
      activeChildren.delete(child);
      if (cause && cause.code === 'ENOENT') {
        capability.rewriteAvailable = false;
        finish(rejectInvocation, rewriteError(
          'rewrite-unavailable',
          'Claude Code is not installed or is not available on PATH.',
          cause,
        ));
        return;
      }
      finish(rejectInvocation, rewriteError(
        'rewrite-failed',
        `Could not start Claude Code: ${cause.message}`,
        cause,
      ));
    });
    child.once('close', (code, signal) => {
      activeChildren.delete(child);
      if (settled) return;
      if (code !== 0) {
        if (launch.shimPath && !isExecutable(launch.shimPath)) {
          capability.rewriteAvailable = false;
          finish(rejectInvocation, rewriteError(
            'rewrite-unavailable',
            'Claude Code is not installed or is not available on PATH.',
          ));
          return;
        }
        const detail = claudeFailureDetail(stderr, stdout, code, signal);
        finish(rejectInvocation, rewriteError(
          'rewrite-failed',
          `Claude Code rewrite failed: ${detail}`,
        ));
        return;
      }

      let result;
      try {
        result = JSON.parse(stdout);
      } catch (cause) {
        finish(rejectInvocation, rewriteError(
          'rewrite-invalid-response',
          'Claude Code returned an unreadable JSON response.',
          cause,
        ));
        return;
      }
      if (!result || typeof result !== 'object' || typeof result.result !== 'string') {
        finish(rejectInvocation, rewriteError(
          'rewrite-invalid-response',
          'Claude Code response did not contain rewritten text.',
        ));
        return;
      }
      finish(resolveInvocation, result.result);
    });

    child.stdin.once('error', (cause) => {
      if (settled) return;
      terminateClaudeChild(child, launch, { spawnSyncImpl });
      finish(rejectInvocation, rewriteError(
        'rewrite-failed',
        `Could not send the memory to Claude Code: ${cause.message}`,
        cause,
      ));
    });
    child.stdin.end(prompt);
  });
}

function executableFile(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolveClaudeLaunch(environment = process.env, {
  platform = process.platform,
  isExecutable = executableFile,
} = {}) {
  const windows = platform === 'win32';
  const pathApi = windows ? path.win32 : path;
  const delimiter = windows ? ';' : path.delimiter;
  const searchPath = environment.PATH || environment.Path || environment.path || '';
  const extensions = windows
    ? String(environment.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];

  for (const directory of searchPath.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = pathApi.join(directory.replace(/^"|"$/g, ''), `claude${extension}`);
      if (!isExecutable(candidate)) continue;

      if (windows && /\.(?:cmd|bat)$/i.test(extension)) {
        const systemRoot = environment.SystemRoot || environment.SYSTEMROOT;
        const command = environment.ComSpec || environment.COMSPEC || 'cmd.exe';
        return {
          command,
          argsPrefix: ['/d', '/s', '/c', candidate],
          shimPath: candidate,
          treeKillCommand: path.win32.isAbsolute(command)
            ? path.win32.join(path.win32.dirname(command), 'taskkill.exe')
            : (systemRoot
              ? path.win32.join(systemRoot, 'System32', 'taskkill.exe')
              : 'taskkill.exe'),
        };
      }
      return { command: candidate, argsPrefix: [], shimPath: candidate };
    }
  }
}

async function runClaudeRewrite(content, instruction, {
  spawnImpl = spawn,
  env = process.env,
  timeoutMs = CLAUDE_REWRITE_TIMEOUT_MS,
  capability = { rewriteAvailable: true },
  fastModel = CLAUDE_FAST_MODEL,
  activeChildren = new Set(),
  maxOutputBytes = MAX_CLAUDE_OUTPUT_BYTES,
  nowImpl = Date.now,
  isExecutable = executableFile,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (capability.rewriteStopping) {
    throw rewriteError('rewrite-cancelled', 'Claude Code rewrite was cancelled because SCMD is closing.');
  }
  if (!capability.rewriteAvailable) {
    throw rewriteError(
      'rewrite-unavailable',
      'Claude Code is not installed or is not available on PATH.',
    );
  }

  const prompt = buildRewritePrompt(content, instruction);
  const startedAt = nowImpl();
  try {
    return await runClaudeInvocation(
      prompt,
      ['-p', '--output-format', 'json', '--model', fastModel],
      {
        spawnImpl,
        env,
        timeoutMs,
        capability,
        activeChildren,
        maxOutputBytes,
        isExecutable,
        spawnSyncImpl,
      },
    );
  } catch (error) {
    if (
      capability.rewriteStopping
      || error.code === 'rewrite-unavailable'
      || error.code === 'rewrite-timeout'
    ) throw error;
  }

  const remainingMs = timeoutMs - Math.max(0, nowImpl() - startedAt);
  if (remainingMs <= 0) {
    throw rewriteError(
      'rewrite-timeout',
      `Claude Code rewrite timed out after ${timeoutMs} ms.`,
    );
  }
  return runClaudeInvocation(
    prompt,
    ['-p', '--output-format', 'json'],
    {
      spawnImpl,
      env,
      timeoutMs: remainingMs,
      capability,
      activeChildren,
      maxOutputBytes,
      isExecutable,
      spawnSyncImpl,
    },
  );
}

function openBrowser(url) {
  const opener = browserCommand(process.platform, url);
  if (!opener) return;

  try {
    const child = spawn(opener.command, opener.args, {
      detached: true,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: opener.windowsVerbatimArguments === true,
    });
    child.once('error', () => {});
    child.unref();
  } catch {
    // The printed URL remains usable if no platform opener is available.
  }
}

function createHeartbeat(server, sockets, onStop = () => {}) {
  const clients = new Map();
  let exitTimer;
  let stopping = false;

  function eventBlock(event) {
    return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  }

  function cancelExit() {
    if (!exitTimer) return;
    clearTimeout(exitTimer);
    exitTimer = undefined;
  }

  function stop() {
    if (stopping) return;
    stopping = true;
    cancelExit();
    onStop();
  }

  function scheduleExit() {
    if (stopping || clients.size > 0 || exitTimer) return;

    exitTimer = setTimeout(() => {
      exitTimer = undefined;
      stop();
      server.close(() => {
        process.exitCode = 0;
      });
      for (const socket of sockets) socket.destroy();
    }, NO_CLIENT_EXIT_MS);
  }

  function removeClient(response) {
    const state = clients.get(response);
    if (!state) return;
    clients.delete(response);
    if (state.onDrain) response.removeListener('drain', state.onDrain);
    if (clients.size === 0) scheduleExit();
  }

  function writeClient(state, event) {
    if (state.response.destroyed || state.response.writableEnded) {
      removeClient(state.response);
      return;
    }
    if (state.blocked) {
      state.pendingResync = true;
      return;
    }

    try {
      if (state.response.write(eventBlock(event))) return;
      state.blocked = true;
      state.onDrain = () => {
        state.onDrain = undefined;
        state.blocked = false;
        if (!state.pendingResync) return;
        state.pendingResync = false;
        writeClient(state, { type: 'resync' });
      };
      state.response.once('drain', state.onDrain);
    } catch {
      removeClient(state.response);
      state.response.destroy();
    }
  }

  function connect(response) {
    cancelExit();
    const state = {
      response,
      blocked: false,
      pendingResync: false,
      onDrain: undefined,
    };
    clients.set(response, state);
    response.once('close', () => removeClient(response));
    writeClient(state, { type: 'resync' });
  }

  function broadcast(events) {
    for (const event of events) {
      for (const state of clients.values()) writeClient(state, event);
    }
    if (clients.size === 0) scheduleExit();
  }

  return { broadcast, connect, scheduleExit, stop };
}

function rewriteHttpError(error) {
  if (Number.isInteger(error.statusCode) && typeof error.code === 'string') {
    return {
      statusCode: error.statusCode,
      body: { error: { code: error.code, message: error.message } },
    };
  }
  if (error.code === 'changed-since-read') {
    return {
      statusCode: 409,
      body: {
        error: {
          code: 'changed-since-read',
          message: 'Memory changed since it was read.',
        },
      },
    };
  }

  const statusCode = error.code === 'rewrite-unavailable'
    ? 503
    : (error.code === 'rewrite-timeout' ? 504 : 502);
  return {
    statusCode,
    body: {
      error: {
        code: typeof error.code === 'string' ? error.code : 'rewrite-failed',
        message: error.message || 'Claude Code rewrite failed.',
      },
    },
  };
}

function createRequestHandler(
  server,
  sockets,
  token,
  heartbeat,
  root,
  stateDir,
  projectPathCache,
  rewriteCapability,
  memoryWatcher,
) {
  return (request, response) => {
    if (!isLoopbackHost(request.headers.host)) {
      sendText(response, 403, 'Forbidden\n');
      return;
    }

    let requestUrl;
    try {
      requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    } catch {
      sendText(response, 400, 'Bad Request\n');
      return;
    }

    if (requestUrl.pathname.startsWith('/api/')) {
      if (!hasToken(request, token)) {
        sendText(response, 401, 'Unauthorized\n');
        return;
      }

      if (requestUrl.pathname === '/api/quit' && request.method === 'POST') {
        heartbeat.stop();
        response.setHeader('Connection', 'close');
        response.once('finish', () => {
          server.close(() => {
            process.exitCode = 0;
          });
          for (const socket of sockets) {
            if (socket !== request.socket) socket.destroy();
          }
        });
        sendText(response, 200, 'Closed\n');
        return;
      }

      if (requestUrl.pathname === '/api/events' && request.method === 'GET') {
        Promise.resolve()
          .then(() => memoryWatcher.start())
          .then(() => {
            if (response.destroyed || response.writableEnded) return;
            response.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            });
            heartbeat.connect(response);
          })
          .catch(() => {
            if (response.headersSent || response.destroyed) return;
            sendJson(response, 500, {
              error: {
                code: 'memory-watch-failed',
                message: 'Could not watch memory folders.',
              },
            });
          });
        return;
      }

      if (requestUrl.pathname === '/api/status' && request.method === 'GET') {
        sendJson(response, 200, {
          rewriteAvailable: rewriteCapability.rewriteAvailable,
        });
        return;
      }

      if (requestUrl.pathname.startsWith('/api/origin/') && request.method === 'GET') {
        Promise.resolve()
          .then(async () => {
            const budget = createOriginBudget();
            let id;
            try {
              id = decodeURIComponent(requestUrl.pathname.slice('/api/origin/'.length));
            } catch {
              throw requestBodyError(404, 'unknown-id', 'Memory was not found.');
            }
            const target = await resolveOriginTargetWithBudget(root, id, budget);
            if (originBudgetExpired(budget)) {
              sendJson(response, 200, originNotFound('lookup-timed-out'));
              return;
            }
            if (!target) {
              throw requestBodyError(404, 'unknown-id', 'Memory was not found.');
            }
            sendJson(response, 200, await findMemoryOriginWithBudget(root, target, budget));
          })
          .catch((error) => {
            if (response.headersSent || response.destroyed) return;
            if (error?.code === 'origin-timeout') {
              sendJson(response, 200, originNotFound('lookup-timed-out'));
              return;
            }
            if (Number.isInteger(error.statusCode) && typeof error.code === 'string') {
              sendJson(response, error.statusCode, {
                error: { code: error.code, message: error.message },
              });
              return;
            }
            sendJson(response, 500, {
              error: {
                code: 'origin-lookup-failed',
                message: 'Could not find memory origin.',
              },
            });
          });
        return;
      }

      if (requestUrl.pathname.startsWith('/api/memory/') && request.method === 'GET') {
        Promise.resolve()
          .then(async () => {
            let id;
            try {
              id = decodeURIComponent(requestUrl.pathname.slice('/api/memory/'.length));
            } catch {
              throw requestBodyError(404, 'unknown-id', 'Memory was not found.');
            }
            const cardTargets = new Map();
            await listProjects(root, projectPathCache, {}, true, cardTargets);
            const scannedTarget = cardTargets.get(id);
            if (!scannedTarget) {
              throw requestBodyError(404, 'unknown-id', 'Memory was not found.');
            }

            const target = await recoverTrustedMemoryTarget(scannedTarget);
            await assertTrustedMemoryDirectory(target);
            const source = await readMemoryForDelete(target.filePath, target.card.hash);
            sendJson(response, 200, {
              ...target.card,
              content: decodeUtf8(source.bytes, 'Memory file'),
            });
          })
          .catch((error) => {
            if (response.headersSent || response.destroyed) return;
            if (Number.isInteger(error.statusCode) && typeof error.code === 'string') {
              sendJson(response, error.statusCode, {
                error: { code: error.code, message: error.message },
              });
              return;
            }
            if (error.code === 'changed-since-read') {
              const failure = rewriteHttpError(error);
              sendJson(response, failure.statusCode, failure.body);
              return;
            }
            sendJson(response, 500, {
              error: {
                code: 'memory-read-failed',
                message: 'Could not read memory.',
              },
            });
          });
        return;
      }

      if (requestUrl.pathname === '/api/rewrite' && request.method === 'POST') {
        Promise.resolve()
          .then(async () => {
            const payload = await readJsonRequest(request);
            if (
              !payload
              || typeof payload !== 'object'
              || Array.isArray(payload)
              || typeof payload.id !== 'string'
              || payload.id.length === 0
              || typeof payload.instruction !== 'string'
              || payload.instruction.trim().length === 0
              || (
                Object.prototype.hasOwnProperty.call(payload, 'content')
                && typeof payload.content !== 'string'
              )
            ) {
              throw requestBodyError(
                400,
                'invalid-request',
                'Request body must identify one memory and contain a rewrite instruction.',
              );
            }
            if (
              typeof payload.content === 'string'
              && Buffer.byteLength(payload.content) > MAX_REWRITE_CONTENT_BYTES
            ) {
              throw requestBodyError(
                413,
                'rewrite-content-too-large',
                'Staged memory content is too large to rewrite.',
              );
            }

            const cardTargets = new Map();
            await listProjects(root, projectPathCache, {}, true, cardTargets);
            const scannedTarget = cardTargets.get(payload.id);
            if (!scannedTarget) {
              throw requestBodyError(404, 'unknown-id', 'Memory was not found.');
            }

            const target = await recoverTrustedMemoryTarget(scannedTarget);
            await assertTrustedMemoryDirectory(target);
            const source = await readMemoryForDelete(target.filePath, target.card.hash);
            const content = typeof payload.content === 'string'
              ? payload.content
              : decodeUtf8(source.bytes, 'Memory file');
            const validationSource = typeof payload.content === 'string'
              ? createMemoryCard({
                  projectId: target.card.projectId,
                  fileName: target.card.fileName,
                  bytes: Buffer.from(content, 'utf8'),
                  mtime: new Date(0),
                })
              : target.card;
            const text = await runClaudeRewrite(content, payload.instruction, {
              capability: rewriteCapability,
              activeChildren: rewriteCapability.activeChildren,
            });
            const valid = validateRewriteProposal(text, validationSource);
            sendJson(response, 200, valid
              ? { before: content, text, valid: true }
              : {
                  before: content,
                  text,
                  valid: false,
                  reason: 'proposal-could-not-be-used',
                  message: 'The proposal could not be used.',
                });
          })
          .catch((error) => {
            if (response.headersSent || response.destroyed) return;
            if (error.code === 'request-too-large') {
              response.setHeader('Connection', 'close');
              response.once('finish', () => request.destroy());
            }
            const failure = rewriteHttpError(error);
            sendJson(response, failure.statusCode, failure.body);
          });
        return;
      }

      if (requestUrl.pathname === '/api/projects' && request.method === 'GET') {
        const includeReviewed = requestUrl.searchParams.get('includeReviewed') === '1';
        Promise.resolve()
          .then(async () => {
            let history;
            let notices = [];
            try {
              history = await readReviewHistory(stateDir);
            } catch (error) {
              if (!['review-history-invalid', 'review-history-read-failed'].includes(error.code)) {
                throw error;
              }
              history = emptyReviewHistory();
              notices = [REVIEW_HISTORY_NOTICE];
            }

            const projects = await listProjects(
              root,
              projectPathCache,
              history.entries,
              includeReviewed,
            );
            sendJson(response, 200, { root, projects, notices });
          })
          .catch(() => sendJson(response, 500, {
            error: {
              code: 'project-scan-failed',
              message: 'Could not list projects.',
            },
          }));
        return;
      }

      if (requestUrl.pathname === '/api/instructions' && request.method === 'GET') {
        Promise.resolve()
          .then(async () => sendJson(
            response,
            200,
            await listInstructionFiles(root, projectPathCache),
          ))
          .catch(() => sendJson(response, 500, {
            error: {
              code: 'instruction-scan-failed',
              message: 'Could not list instruction files.',
            },
          }));
        return;
      }

      if (requestUrl.pathname === '/api/trash' && request.method === 'GET') {
        Promise.resolve()
          .then(async () => sendJson(response, 200, await listTrashRuns(root, stateDir)))
          .catch(() => sendJson(response, 500, {
            error: {
              code: 'trash-list-failed',
              message: 'Could not list trash.',
            },
          }));
        return;
      }

      if (requestUrl.pathname === '/api/restore' && request.method === 'POST') {
        Promise.resolve()
          .then(async () => {
            const payload = await readJsonRequest(request);
            if (
              !payload
              || typeof payload !== 'object'
              || Array.isArray(payload)
              || typeof payload.runId !== 'string'
              || typeof payload.id !== 'string'
              || payload.runId.length === 0
              || payload.id.length === 0
            ) {
              throw requestBodyError(
                400,
                'invalid-request',
                'Request body must identify one trash item.',
              );
            }
            const result = await restoreTrashItem(root, stateDir, payload.runId, payload.id);
            sendJson(response, 200, { result });
          })
          .catch((error) => {
            if (response.headersSent || response.destroyed) return;
            if (error.code === 'request-too-large') {
              response.setHeader('Connection', 'close');
              response.once('finish', () => request.destroy());
            }
            if (Number.isInteger(error.statusCode) && typeof error.code === 'string') {
              sendJson(response, error.statusCode, {
                error: { code: error.code, message: error.message },
              });
              return;
            }
            sendJson(response, 500, {
              error: {
                code: 'restore-failed',
                message: 'Could not restore memory.',
              },
            });
          });
        return;
      }

      if (requestUrl.pathname === '/api/purge' && request.method === 'POST') {
        Promise.resolve()
          .then(async () => {
            const payload = await readJsonRequest(request);
            if (
              !payload
              || typeof payload !== 'object'
              || Array.isArray(payload)
              || typeof payload.runId !== 'string'
              || payload.runId.length === 0
            ) {
              throw requestBodyError(
                400,
                'invalid-request',
                'Request body must identify one trash run.',
              );
            }
            const result = await purgeTrashRun(root, stateDir, payload.runId);
            sendJson(response, 200, { result });
          })
          .catch((error) => {
            if (response.headersSent || response.destroyed) return;
            if (error.code === 'request-too-large') {
              response.setHeader('Connection', 'close');
              response.once('finish', () => request.destroy());
            }
            if (Number.isInteger(error.statusCode) && typeof error.code === 'string') {
              sendJson(response, error.statusCode, {
                error: { code: error.code, message: error.message },
              });
              return;
            }
            sendJson(response, 500, {
              error: {
                code: 'purge-failed',
                message: 'Could not purge trash.',
              },
            });
          });
        return;
      }

      if (requestUrl.pathname === '/api/apply' && request.method === 'POST') {
        Promise.resolve()
          .then(async () => {
            const payload = await readJsonRequest(request);
            const decisions = Array.isArray(payload) ? payload : payload?.decisions;
            if (!Array.isArray(decisions) || decisions.length > MAX_APPLY_DECISIONS) {
              throw requestBodyError(
                400,
                'invalid-request',
                'Request body must contain a decisions list.',
              );
            }

            const releaseMutation = await memoryWatcher.beginMutation();
            try {
              const results = await applyDecisions(
                root,
                stateDir,
                projectPathCache,
                decisions,
                (transition) => memoryWatcher.suppress([transition]),
              );
              sendJson(response, 200, { results });
            } finally {
              releaseMutation();
            }
          })
          .catch((error) => {
            if (response.headersSent || response.destroyed) return;
            if (error.code === 'request-too-large') {
              response.setHeader('Connection', 'close');
              response.once('finish', () => request.destroy());
            }
            if (Number.isInteger(error.statusCode) && typeof error.code === 'string') {
              sendJson(response, error.statusCode, {
                error: { code: error.code, message: error.message },
              });
              return;
            }
            sendJson(response, 500, {
              error: {
                code: 'apply-failed',
                message: 'Could not apply decisions.',
              },
            });
          });
        return;
      }

      sendText(response, 404, 'Not Found\n');
      return;
    }

    if (request.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html')) {
      fs.readFile(path.join(__dirname, 'index.html'), (error, page) => {
        if (error) {
          sendText(response, 500, 'Could not load SCMD.\n');
          return;
        }

        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': page.length,
        });
        response.end(page);
      });
      return;
    }

    sendText(response, 404, 'Not Found\n');
  };
}

function decodeScalar(value) {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }

  return trimmed;
}

function splitFrontmatter(text) {
  const firstLineEnd = text.indexOf('\n');
  const firstLine = text
    .slice(0, firstLineEnd === -1 ? text.length : firstLineEnd)
    .replace(/\r$/, '')
    .replace(/^\uFEFF/, '');
  if (firstLine !== '---') {
    return { body: text, top: {}, metadata: {}, hasFrontmatter: false };
  }

  const lines = [];
  let cursor = firstLineEnd === -1 ? text.length : firstLineEnd + 1;
  let bodyStart;
  while (cursor <= text.length) {
    const nextNewline = text.indexOf('\n', cursor);
    const lineEnd = nextNewline === -1 ? text.length : nextNewline;
    const line = text.slice(cursor, lineEnd).replace(/\r$/, '');
    if (line === '---') {
      bodyStart = nextNewline === -1 ? text.length : nextNewline + 1;
      break;
    }
    lines.push(line);
    if (nextNewline === -1) break;
    cursor = nextNewline + 1;
  }

  if (bodyStart === undefined) {
    return { body: text, top: {}, metadata: {}, hasFrontmatter: false };
  }

  const top = {};
  const metadata = {};
  let inMetadata = false;
  for (const line of lines) {
    const topLevel = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (topLevel) {
      const [, key, rawValue] = topLevel;
      inMetadata = key === 'metadata' && rawValue.trim() === '';
      if (key !== 'metadata') top[key] = decodeScalar(rawValue);
      continue;
    }

    const nested = /^[ \t]+([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (inMetadata && nested) {
      metadata[nested[1]] = decodeScalar(nested[2]);
      continue;
    }

    if (line.trim() && !line.trimStart().startsWith('#')) inMetadata = false;
  }

  return { body: text.slice(bodyStart), top, metadata, hasFrontmatter: true };
}

function firstNonEmptyLine(text) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
}

function firstValue(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim();
}

function validateRewriteProposal(text, sourceCard) {
  if (typeof text !== 'string' || !sourceCard || typeof sourceCard !== 'object') return false;

  const { hasFrontmatter, top, metadata } = splitFrontmatter(text);
  if (!hasFrontmatter) return false;

  const name = firstValue(top.name);
  const type = firstValue(metadata.type, top.type);
  const expectedName = firstValue(sourceCard.name);
  const expectedType = firstValue(sourceCard.type);
  return Boolean(
    name
    && type
    && expectedName
    && expectedType
    && name === expectedName
    && type === expectedType
  );
}

function typeFromFilename(fileName) {
  const match = /^(feedback|project|reference|user)_/i.exec(fileName);
  return match ? match[1].toLowerCase() : undefined;
}

function validIsoDate(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const timestamp = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(timestamp);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth[month - 1]
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) return undefined;

  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function createMemoryCard({ projectId, fileName, bytes, mtime }) {
  const sourceBytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const text = decodeUtf8(sourceBytes, 'Memory file');

  const { body, top, metadata } = splitFrontmatter(text);
  const stem = path.basename(fileName, path.extname(fileName));
  const name = firstValue(top.name, stem) || 'Untitled memory';
  const summary = firstValue(top.description, firstNonEmptyLine(body), name) || name;
  const modified = validIsoDate(metadata.modified);
  const fallbackDate = new Date(mtime);
  const card = {
    id: `${projectId}/${fileName}`,
    fileName,
    projectId,
    name,
    summary,
    type: firstValue(metadata.type, top.type, typeFromFilename(fileName)) || 'unknown',
    date: modified || fallbackDate.toISOString(),
    body,
    hash: crypto.createHash('sha256').update(sourceBytes).digest('hex'),
  };
  const originSessionId = firstValue(metadata.originSessionId, top.originSessionId);
  if (originSessionId) card.originSessionId = originSessionId;
  return card;
}

function main() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 18) {
    fail('SCMD requires Node.js 18 or newer.');
    return;
  }

  const options = parseArgs(process.argv.slice(2));

  if (options && rootExists(options.root)) {
    const token = crypto.randomBytes(16).toString('hex');
    const server = http.createServer();
    const sockets = new Set();
    const projectPathCache = new Map();
    const activeChildren = new Set();
    const launch = resolveClaudeLaunch();
    const rewriteCapability = {
      rewriteAvailable: Boolean(launch),
      launch,
      activeChildren,
    };
    let memoryWatcher;
    const heartbeat = createHeartbeat(
      server,
      sockets,
      () => {
        memoryWatcher?.stop();
        rewriteCapability.rewriteStopping = true;
        terminateActiveRewrites(activeChildren, rewriteCapability.launch);
      },
    );
    memoryWatcher = createMemoryWatcher({
      root: options.root,
      emit: (events) => heartbeat.broadcast(events),
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    server.on('request', createRequestHandler(
      server,
      sockets,
      token,
      heartbeat,
      options.root,
      options.stateDir,
      projectPathCache,
      rewriteCapability,
      memoryWatcher,
    ));

    server.once('error', (error) => {
      fail(
        `Could not listen on 127.0.0.1:${options.port}: ${display(error.code || 'UNKNOWN')} (${display(error.message)})`,
      );
    });
    server.listen(options.port, '127.0.0.1', () => {
      const { port } = server.address();
      const launchUrl = `http://127.0.0.1:${port}/?token=${token}`;
      heartbeat.scheduleExit();
      process.stdout.write(`SCMD running at ${launchUrl}\n`);
      if (options.openBrowser) openBrowser(launchUrl);
    });
  } else if (options) {
    fail(`Root directory does not exist or is not a directory: ${display(options.rootInput || options.root)}`);
  }
}

if (require.main === module) main();

module.exports = {
  ORIGIN_LIMITS,
  applyDelete,
  applyEdit,
  buildRewritePrompt,
  createMemoryCard,
  createMemoryWatcher,
  createHeartbeat,
  createTrashRun,
  diffMemorySnapshots,
  findMemoryOrigin,
  moveFileNoReplace,
  readIndexForDelete,
  recordReviewed,
  resolveOriginTarget,
  resolveClaudeLaunch,
  restoreIndexLines,
  rewriteHttpError,
  runClaudeRewrite,
  scanMemorySnapshot,
  terminateActiveRewrites,
  terminateClaudeChild,
  validateRewriteProposal,
  rewriteIndexForDelete,
};
