/**
 * Yjs 文档版本快照管理
 *
 * 导出：createSnapshotManager(docs, options?)
 *   docs —— 所有活跃 Yjs 文档的 Map<projectId, Y.Doc>（由协作主服务注入）
 *   options.createDoc —— 可选，(projectId) => Y.Doc，用于回滚时创建新文档
 *                        （协作主服务可传入 () => new WSSharedDoc(name) 以兼容 y-websocket）
 *
 * 功能：
 *   - 每 5 分钟自动触发一次快照（startAutoSnapshot）
 *   - 手动触发：HTTP POST /snapshot/:projectId   body: { label, createdBy }
 *   - 版本列表：HTTP GET  /snapshot/:projectId
 *   - 回滚：     HTTP POST /snapshot/:projectId/:versionId/rollback
 *   - 快照二进制用 Y.encodeStateAsUpdate(doc) 生成，存到 /tmp/snapshots/{projectId}/{versionId}.yjs
 *   - 元数据（versionId, projectId, createdAt, createdBy, label, size）存内存 Map + 每项目 meta.json
 *
 * 注意：
 *   本模块通过 createRequire 引入 yjs，确保与 y-websocket 内部使用的是同一个 yjs 实例
 *   （否则跨实例 encode/apply 会丢失 Y.Text 内容）。
 *   回滚采用「文档替换」策略：用快照构造一个全新文档替换 docs 中的活跃文档，
 *   并优雅关闭旧文档的连接，使客户端重连后获得回滚后的状态。
 */
import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

const require = createRequire(import.meta.url);
// 必须使用 CJS yjs（与 y-websocket/bin/utils 同一实例），避免跨实例丢内容
const Y = require('yjs');

const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR || '/tmp/snapshots';
const DEFAULT_AUTO_INTERVAL = 5 * 60 * 1000; // 5 分钟
const BODY_LIMIT = 1 * 1024 * 1024; // 1MB

/**
 * @param {Map<string, any>} docs
 * @param {{ createDoc?: (projectId: string) => any }} [options]
 */
export function createSnapshotManager(docs, options = {}) {
  const createDoc = options.createDoc || (() => new Y.Doc());
  // projectId -> Meta[]
  const metaMap = new Map();

  function projectDir(projectId) {
    return path.join(SNAPSHOT_DIR, projectId);
  }

  function metaPath(projectId) {
    return path.join(projectDir(projectId), 'meta.json');
  }

  function loadMeta(projectId) {
    if (metaMap.has(projectId)) return metaMap.get(projectId);
    let arr = [];
    try {
      const raw = fs.readFileSync(metaPath(projectId), 'utf8');
      const parsed = JSON.parse(raw);
      arr = Array.isArray(parsed) ? parsed : [];
    } catch {
      arr = [];
    }
    metaMap.set(projectId, arr);
    return arr;
  }

  function persistMeta(projectId) {
    const arr = metaMap.get(projectId) || [];
    try {
      fs.mkdirSync(projectDir(projectId), { recursive: true });
      fs.writeFileSync(metaPath(projectId), JSON.stringify(arr, null, 2));
    } catch (e) {
      console.error(`[snapshot] persistMeta failed for ${projectId}:`, e.message);
    }
  }

  /**
   * 创建一次快照
   * @param {string} projectId
   * @param {{ label?: string, createdBy?: string }} [opts]
   */
  function createSnapshot(projectId, opts = {}) {
    const doc = docs.get(projectId);
    if (!doc) {
      const err = new Error(`No active document for project: ${projectId}`);
      err.code = 'NO_DOC';
      throw err;
    }
    const bytes = Y.encodeStateAsUpdate(doc);
    const versionId = randomUUID();
    const dir = projectDir(projectId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${versionId}.yjs`), Buffer.from(bytes));

    const meta = {
      versionId,
      projectId,
      createdAt: new Date().toISOString(),
      createdBy: opts.createdBy || 'system',
      label: opts.label || '',
      size: bytes.length,
    };
    const arr = loadMeta(projectId);
    arr.push(meta);
    persistMeta(projectId);
    return meta;
  }

  /**
   * 列出某项目的所有快照（按创建时间倒序）
   */
  function listSnapshots(projectId) {
    return loadMeta(projectId)
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  function readSnapshotBytes(projectId, versionId) {
    const file = path.join(projectDir(projectId), `${versionId}.yjs`);
    if (!fs.existsSync(file)) return null;
    return new Uint8Array(fs.readFileSync(file));
  }

  /**
   * 回滚到指定快照版本（文档替换策略）
   */
  function rollback(projectId, versionId) {
    const arr = loadMeta(projectId);
    const meta = arr.find((m) => m.versionId === versionId);
    if (!meta) {
      const err = new Error(`Snapshot not found: ${projectId}/${versionId}`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    const bytes = readSnapshotBytes(projectId, versionId);
    if (!bytes) {
      const err = new Error(`Snapshot file missing: ${projectId}/${versionId}`);
      err.code = 'NOT_FOUND';
      throw err;
    }

    // 用快照构造全新文档
    const newDoc = createDoc(projectId);
    Y.applyUpdate(newDoc, bytes);

    const oldDoc = docs.get(projectId);
    // 先把新文档放入 Map，使后续新连接直接命中回滚后的文档
    docs.set(projectId, newDoc);

    if (oldDoc && oldDoc !== newDoc) {
      // 中和 y-websocket 的 closeConn：清空旧文档的 conns，避免其连接排空时
      // 触发 docs.delete(doc.name) 把刚放入的同名新文档误删。
      const oldConns =
        oldDoc.conns && oldDoc.conns instanceof Map ? Array.from(oldDoc.conns.keys()) : [];
      if (oldDoc.conns && typeof oldDoc.conns.clear === 'function') {
        try {
          oldDoc.conns.clear();
        } catch {
          /* ignore */
        }
      }
      // 关闭旧连接，促使客户端重连到回滚后的文档
      for (const conn of oldConns) {
        try {
          conn.close();
        } catch {
          /* ignore */
        }
      }
      try {
        if (typeof oldDoc.destroy === 'function') oldDoc.destroy();
      } catch {
        /* ignore */
      }
    }

    return { ok: true, projectId, versionId, createdAt: meta.createdAt, label: meta.label };
  }

  let autoTimer = null;
  function startAutoSnapshot(intervalMs = DEFAULT_AUTO_INTERVAL) {
    stopAutoSnapshot();
    autoTimer = setInterval(() => {
      for (const [projectId, doc] of docs) {
        if (!doc) continue;
        try {
          createSnapshot(projectId, {
            label: `auto-${new Date().toISOString()}`,
            createdBy: 'system',
          });
        } catch (e) {
          console.error(`[snapshot] auto snapshot failed for ${projectId}:`, e.message);
        }
      }
    }, intervalMs);
    if (typeof autoTimer.unref === 'function') autoTimer.unref();
    return stopAutoSnapshot;
  }

  function stopAutoSnapshot() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  }

  function readJsonBody(req) {
    return new Promise((resolve) => {
      let body = '';
      let size = 0;
      let tooLarge = false;
      req.on('data', (chunk) => {
        if (tooLarge) return;
        size += chunk.length;
        if (size > BODY_LIMIT) {
          tooLarge = true;
          try {
            req.destroy();
          } catch {
            /* ignore */
          }
          resolve(null);
          return;
        }
        body += chunk.toString();
      });
      req.on('end', () => {
        if (tooLarge) return;
        if (!body) return resolve({});
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
      req.on('error', () => resolve(null));
    });
  }

  function sendJson(res, status, obj) {
    const data = JSON.stringify(obj);
    try {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch {
      /* response already closed */
    }
  }

  function getPathname(req) {
    try {
      return new URL(req.url, 'http://localhost').pathname;
    } catch {
      return req.url ? req.url.split('?')[0] : '';
    }
  }

  /**
   * HTTP 路由：处理 /snapshot/* 端点
   * @returns {Promise<boolean>} 是否已处理该请求
   */
  async function handleHttp(req, res) {
    const pathname = getPathname(req);
    if (!pathname.startsWith('/snapshot/')) return false;

    try {
      // 回滚：/snapshot/:projectId/:versionId/rollback
      let m = pathname.match(/^\/snapshot\/([^/]+)\/([^/]+)\/rollback$/);
      if (m) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return true;
        }
        const projectId = decodeURIComponent(m[1]);
        const versionId = decodeURIComponent(m[2]);
        try {
          const result = rollback(projectId, versionId);
          sendJson(res, 200, result);
        } catch (e) {
          sendJson(res, e.code === 'NOT_FOUND' ? 404 : 500, { error: e.message });
        }
        return true;
      }

      // /snapshot/:projectId
      m = pathname.match(/^\/snapshot\/([^/]+)$/);
      if (m) {
        const projectId = decodeURIComponent(m[1]);
        if (req.method === 'GET') {
          try {
            sendJson(res, 200, { projectId, snapshots: listSnapshots(projectId) });
          } catch (e) {
            sendJson(res, 500, { error: e.message });
          }
          return true;
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          if (body === null) {
            sendJson(res, 400, { error: 'Invalid JSON body' });
            return true;
          }
          try {
            const meta = createSnapshot(projectId, {
              label: body.label,
              createdBy: body.createdBy || 'http',
            });
            sendJson(res, 201, meta);
          } catch (e) {
            sendJson(res, e.code === 'NO_DOC' ? 404 : 500, { error: e.message });
          }
          return true;
        }
        sendJson(res, 405, { error: 'Method not allowed' });
        return true;
      }
    } catch (e) {
      sendJson(res, 500, { error: e.message });
      return true;
    }

    return false;
  }

  return {
    createSnapshot,
    listSnapshots,
    rollback,
    startAutoSnapshot,
    stopAutoSnapshot,
    handleHttp,
  };
}

export default createSnapshotManager;
