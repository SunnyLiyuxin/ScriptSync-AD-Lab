# ScriptSync — 口述稿全流程协作平台

> 把口述影像准备阶段的 9 个散落步骤（立项→片源→分析→分配→撰写→审阅→定稿→导出→演练）收进一个系统，每一步的输出自动成为下一步的输入。

---

## 一、定位

**面向谁**：口述影像创作者（口述员、统筹、审校）
**解决什么**：当前口述稿准备散落在微信群/Aegisub/Excel/转换网站，无法同步编辑、版本混乱、演练需线下聚集。
**核心价值**：集成 + 云端实时协作 + 全流程记忆 + AI 辅助。

梯度版本：
- **MVP**：格式转换 + 波形打轴 + 多人实时协作 + 片源管理 + 段落锁/@指派 + 空白段跳转 + 版本记忆
- **V1.5**：快捷键 + AI 客观中性改写 + AI 用词一致性 + AI 时长预估 + 批注 + 修改追踪
- **V2**：多人语音房间 + 同步播放 + 口述演练 + 录音存档 + AI 衔接检查

---

## 二、技术架构

```
┌─ 前端（Svelte 5 + TS + Vite）─────────────────────────────┐
│  Yjs 客户端 + y-websocket + y-indexeddb（离线缓存）         │
│  Web Audio API（本地模式波形 fallback）+ Canvas（波形渲染） │
│  SheetJS（Excel 预览）+ 自写 ASS/SRT/WebVTT 序列化          │
└────────────────────────────────────────────────────────────┘
          ↕ WebSocket（协作+同步播放）   ↕ HTTPS（API/AI）
┌─ 协作服务端（Node.js，部署 ECS）──────────────────────────┐
│  y-websocket 服务端（CRDT 同步核心）                         │
│  独立 /sync-play WebSocket（低延迟播放同步，不走 Yjs）       │
│  JWT 鉴权 + 房间隔离 + 版本快照定时器                        │
└────────────────────────────────────────────────────────────┘
          ↕
┌─ 业务 API + AI（Python FastAPI，部署百炼 K8s）────────────┐
│  项目 CRUD + 文件转换（复用 ScriptGrid 解析器）             │
│  FFmpeg 波形/静音检测（生产）/ 本地 fallback                │
│  SUP OCR（百炼 OCR，精度优先）                              │
│  AI 客观中性改写/一致性/时长预估/衔接检查（dashscope）       │
│  BackgroundTasks 异步（SUP OCR 等慢任务）                   │
└────────────────────────────────────────────────────────────┘
          ↕
┌─ 持久化 ──────────────────────────────────────────────────┐
│  RDS MySQL（项目/成员/版本/状态机）  生产                    │
│  SQLite（本地开发）                                          │
│  OSS（片源/Yjs 快照/录音）           生产                    │
│  本地文件系统（本地开发）                                    │
└────────────────────────────────────────────────────────────┘
```

---

## 三、关键技术决策与理由

### 3.1 数据结构：保留扩展的 `AssEvent`（不回退到简化的 `CueEntry`）

**决策**：采用 `AssEvent`（7 态状态机 + `_assignedTo`/`_lockedBy`/`_reviewComments` 等元数据字段），不采用简化版 `CueEntry`（3 态、无 layer/name）。

**理由**：
- `_assignedTo` 是权限校验的核心依据（数据层 `canEdit()` 校验），回退会丢失权限保护
- 7 态状态机（empty→draft→peer_review→revision_needed→approved→locked→deleted）覆盖完整流程，3 态不够
- ASS 原生 Layer 字段用于区分对白/口述，导出时按 layer 分流，`CueEntry` 缺这个字段
- 已实现的 `yjs-operations.ts` 全部基于 `AssEvent` 结构，回退等于推翻重写

**未来迭代**：字段已预留 V1.5/V2 扩展（`_aiSuggestion`/`_audioRecording`/`_rehearsalState`），梯度升级不破坏现有数据。

---

### 3.2 波形与静音检测：混合方案

**决策**：
- **生产模式**：视频上云 → 后端 FFmpeg 提取 WAV → audiowaveform 生成精确 JSON → 存 OSS → 前端加载
- **本地模式**：前端 Web Audio API `decodeAudioData` 降采样取峰值（fallback）
- **切换逻辑**：后端有波形数据时前端优先用，否则降级到前端提取

**理由**：
- 生产环境必须后端处理：浏览器解码器差异、大文件卡死、多人共享需统一波形数据源
- 本地开发保留前端 fallback：开发时不强制装 FFmpeg/audiowaveform，降低环境门槛
- 隐私：生产环境片源本就要上云共享给协作者，"本地导入"只是开发期便利

**未来迭代**：本地模式最终会废弃，统一走后端。

---

### 3.3 Excel 处理：后端 Python openpyxl

**决策**：后端用 openpyxl，不用 ExcelJS（Node.js）。

**理由**：
- 后端是 Python，复用 ScriptGrid 已验证的 openpyxl 实现，零成本
- ExcelJS 是 Node.js 库，引入意味着把 Excel 处理移到协作服务端，职责混乱
- 前端如需 Excel 预览可用 SheetJS，但导出走后端

---

### 3.4 异步任务：FastAPI BackgroundTasks（MVP）→ Celery+Redis（生产）

**决策**：
- **MVP/本地**：FastAPI BackgroundTasks（无 Redis 依赖，进程内异步）
- **生产**：升级到 Celery + Redis（持久化任务队列，支持重试/监控）

**理由**：
- BullMQ 是 Node.js 生态，跨语言栈复杂，不采用
- MVP 阶段只有 SUP OCR 是慢任务（几十秒），BackgroundTasks 够用
- 生产环境任务量大时升级 Celery，代码接口不变（任务函数签名一致）

**未来迭代**：`services/api/tasks/` 目录已规划，Celery worker 独立部署。

---

### 3.5 SUP OCR：百炼 OCR（精度优先）

**决策**：SUP 图形字幕 OCR 用百炼 OCR，不用 Tesseract。

**理由**：
- 中文精度：百炼 OCR 中文识别显著优于 Tesseract，生产系统精度优先
- 生态统一：与 AI 改写/一致性等能力同属百炼，统一鉴权统一计费
- 运维省心：云端 API，无需本地装 Tesseract + 中文语言包

**未来迭代**：保留 `ocr_engine` 配置项，未来可切换其他 OCR 引擎。

---

### 3.6 快捷键：Svelte 原生 `svelte:window on:keydown`

**决策**：Svelte 原生实现，不用 React-hotkeys。

**理由**：
- React-hotkeys 是 React 生态，Svelte 项目不能用
- Svelte 原生 `on:keydown` 足够，已实现基础版（上下键/Enter/Esc），扩展为完整 Aegisub 级即可
- 无第三方依赖，体积小

---

### 3.7 同步播放：独立 WebSocket 协议（不走 Yjs Awareness）

**决策**：协作服务端新增 `/sync-play/<projectId>` WebSocket 端点，专门广播播放状态。

**理由**：
- Yjs Awareness 为协作光标设计，高频播放状态会拖累文档同步
- 播放同步是毫秒级实时需求，独立通道更稳
- 协议清晰：`{type:'play'|'pause'|'seek', currentTime, controllerId}`

---

### 3.8 V2 语音房间：百炼实时多模态 WebSocket

**决策**：用百炼实时多模态 WebSocket，不用声网 Agora。

**理由**：
- 比赛要求用百炼平台，统一生态加分
- Agora 虽成熟但脱离百炼，且额外付费
- 百炼多模态 WebSocket 本就是为实时音视频交互设计，与同步播放共用 WebSocket 基础设施

**未来迭代**：如百炼实时能力不足，可切换 Agora，前端封装抽象层。

---

### 3.9 版本快照：Y.encodeStateAsUpdate + 定时器

**决策**：
- 协作服务端每 5 分钟定时 + 手动触发端点
- `Y.encodeStateAsUpdate(doc)` 生成二进制 → 存 versions 表（本地）/ OSS（生产）
- 支持回滚到任意历史版本

**理由**：Yjs 原生能力，无额外依赖。

---

## 四、本地 vs 生产 配置对照

| 组件 | 本地开发 | 生产部署 | 切换方式 |
|---|---|---|---|
| 前端 | `localhost:5173` | Cloudflare Pages / 百炼静态托管 | `VITE_API_URL` 环境变量 |
| API | `localhost:8000` | 百炼 K8s | `JWT_SECRET` 等环境变量 |
| 协作 WS | `localhost:1234` | 你的 ECS | `VITE_COLLAB_WS_URL` |
| 同步播放 WS | `localhost:1235` | 你的 ECS | `VITE_SYNC_WS_URL` |
| 数据库 | SQLite 文件 | RDS MySQL | `DB_PATH` / `DATABASE_URL` |
| 文件存储 | 本地 `/tmp` | OSS | `UPLOAD_DIR` / `OSS_*` |
| FFmpeg | 可选本地装 | 百炼 K8s 镜像内置 | `USE_FFMPEG` 开关 |
| AI 模型 | 可空（mock） | 百炼 dashscope | `DASHSCOPE_API_KEY` |
| OCR | 可空 | 百炼 OCR | `DASHSCOPE_API_KEY` |

**原则**：同一套代码，只改环境变量，不改代码逻辑。

---

## 五、目录结构

```
scriptsync/
├── frontend/                    # Svelte 5 前端
│   ├── src/
│   │   ├── lib/
│   │   │   ├── ass/             # ASS 解析/序列化/标签/时间
│   │   │   ├── audio/           # Web Audio 波形/静音（本地 fallback）
│   │   │   ├── collaboration/   # Yjs 协作层
│   │   │   ├── export/          # ASS/SRT/Excel/WebVTT 导出
│   │   │   ├── ai/              # AI 调用封装
│   │   │   ├── shortcuts/       # 快捷键体系（V1.5）
│   │   │   ├── sync-play/       # 同步播放协议客户端（V2）
│   │   │   ├── voice-room/      # 语音房间客户端（V2）
│   │   │   └── render/          # Canvas 波形渲染
│   │   ├── components/          # Svelte 组件
│   │   │   ├── TimelineEditor.svelte       # 主编辑器（表格）
│   │   │   ├── EventCard.svelte            # 字幕行（保留备用）
│   │   │   ├── WaveformDisplay.svelte
│   │   │   ├── VideoPlayer.svelte
│   │   │   ├── ExportPanel.svelte          # 导出中心
│   │   │   ├── ReviewPanel.svelte          # 批注面板
│   │   │   ├── AiReviewPanel.svelte        # AI 检测面板
│   │   │   ├── VoiceRoom.svelte            # 语音房间（V2）
│   │   │   ├── Teleprompter.svelte         # 提词器（V2）
│   │   │   └── VersionHistory.svelte       # 版本历史
│   │   ├── routes/
│   │   │   ├── +page.svelte                # 项目列表
│   │   │   └── editor/[id]/+page.svelte    # 编辑器入口
│   │   └── types/                          # 类型定义
│   └── vite.config.ts
│
├── services/
│   ├── api/                     # Python FastAPI
│   │   ├── app.py               # 主入口
│   │   ├── parsers/             # ASS/SRT/Excel/SUP 解析
│   │   ├── writers/             # SRT/Excel/WebVTT 导出
│   │   ├── ai/                  # AI 调用层
│   │   ├── tasks/               # 异步任务（BackgroundTasks/Celery）
│   │   └── ffmpeg/              # FFmpeg 波形/静音（生产）
│   │
│   └── collab/                  # Node.js 协作服务端
│       ├── src/
│       │   ├── server.js        # y-websocket 主服务
│       │   ├── sync-play.js     # 同步播放 WebSocket
│       │   ├── voice-room.js    # 语音房间信令（V2）
│       │   ├── snapshot.js      # 版本快照定时器
│       │   └── issue-token.js   # JWT 签发工具
│       └── package.json
│
├── docker-compose.yml           # 本地一键启动
├── .env.example
└── README.md
```

---

## 六、本地启动

```bash
# 1. 复制配置
cp .env.example .env
# 编辑 .env，填 JWT_SECRET（必填）和 DASHSCOPE_API_KEY（可选，AI 功能需要）

# 2. 启动三端
docker-compose up --build
# 或分端启动（见下文）

# 3. 生成登录 token
cd services/collab
JWT_SECRET=scriptsync-local-dev-secret-2026 node src/issue-token.js user001 测试员 proj001

# 4. 浏览器访问 http://localhost:5173
```

分端启动：
```bash
# 协作服务端
cd services/collab && JWT_SECRET=xxx PORT=1234 node src/server.js

# API
cd services/api && JWT_SECRET=xxx uvicorn app:app --port 8000

# 前端
cd frontend && npm run dev
```

---

## 七、未来迭代方向

1. **权限细化**：当前 `_assignedTo` 单一负责人，未来支持"段落负责人 + 全局审校"多角色
2. **AI 代笔**：当前 AI 仅辅助审校，未来支持 Qwen-VL 看视频自动生成口述初稿
3. **TTS 预合成**：口述稿 → CosyVoice 合成 → 与原片混音预览
4. **手语输出**：Qwen 多模态生成手语描述文本，服务聋盲群体
5. **Celery 升级**：任务量增大时从 BackgroundTasks 升级
6. **多格式导出**：当前 ASS/SRT/Excel/WebVTT，未来加 PDF/TXT/ITT
7. **Agora 备份**：百炼实时能力不足时切换声网

---

## 八、参考资产

- **ScriptGrid**（格式转换引擎）：ASS/SRT/Excel/SUP 解析器、OCR 帧去重缓存算法
- **ScriptSync**（协作编辑原型）：Yjs 数据模型、波形/静音检测、Canvas 渲染、ASS 序列化
