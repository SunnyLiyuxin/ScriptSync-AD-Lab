# 述格 ScriptGrid 技术背景剖析

> 目标站点：`https://sg.kadaiad.fun:4680/`
> 开源仓库：https://github.com/yunshenwuji/ScriptGrid
> 领域定位：面向「口述影像 / 无障碍电影」创作者的字幕‑表格互转与自动打轴工具

---

## 一、整体技术栈与架构

### 1.1 技术选型

| 层级 | 技术 | 作用 |
| --- | --- | --- |
| Web 框架 | **FastAPI** 0.141.1 | 异步 ASGI Web 服务，提供上传/转换/下载 REST 接口 |
| 应用服务器 | **Uvicorn** 0.52.1 (standard) | ASGI 服务器，承载 FastAPI |
| 表单解析 | **python-multipart** 0.0.32 | 解析 `multipart/form-data` 文件上传 |
| 表格读写 | **openpyxl** 3.1.5 | `.xlsx` 的流式读取与写出 |
| 图形字幕 OCR | **torchfree_ocr** 1.1.0 | **PyTorch‑Free** 版 EasyOCR，基于 ONNX Runtime |
| PGS 解析 | **pgsreader** + **imagemaker** | 解析 Blu‑ray `.sup` (PGS) 位图字幕并重建图像 |
| 图像处理 | **Pillow (PIL)** + **NumPy** | 字幕位图预处理、数组化送入 OCR |
| 前端 | 原生 HTML + **Bootstrap 5.3** + 原生 JS (`app.js`) | 单页表单 UI，`data-i18n` 国际化 |
| 跨域 | FastAPI `CORSMiddleware` | 允许前后端分离部署 |

### 1.2 架构模式：Parse → IR → Write 管线

整个系统采用经典的**适配器/管道架构**。所有格式的解析器（Parser）统一产出一个**中间表示（Intermediate Representation, IR）**，再由写入器（Writer）统一序列化为目标格式：

```
IR（中间表示） = List[List[str]]
每行 = [序号, 开始时间, 结束时间, 字幕内容]
        例如 ["1", "00:00:06,400", "00:00:09,000", "你好"]
```

这一设计是“ASS→SRT、ASS/SRT→Excel、Excel→SRT、SUP→SRT/Excel”能够互通的**核心抽象**：解析端只负责“格式→IR”，写入端只负责“IR→格式”，互不耦合，新增格式只需新增一对 Parser/Writer。

```
┌────────┐   parse   ┌────┐   write   ┌────────┐
│ .ass   │ ────────▶ │    │ ────────▶ │ .srt   │
│ .srt   │ ────────▶ │ IR │ ────────▶ │ .xlsx  │
│ .xlsx  │ ────────▶ │    │ ────────▶ │ 口述稿  │
│ .sup   │ ──OCR───▶ │    │           │        │
└────────┘           └────┘           └────────┘
```

后端入口 `app.py` 负责 HTTP 层（上传、任务编排、进度推送、文件下载），核心业务逻辑收敛在 `subtitle_converter.py`，按 `conversion_type` 派发到不同 Parser/Writer。

---

## 二、ASS → SRT 转换的技术实现

源文件：`parsers/ass_parser.py`

### 2.1 ASS 格式背景

ASS (Advanced SubStation Alpha) 是基于纯文本的字幕格式，时间精度为**厘秒（centisecond, 1/100s）**，时间形如 `0:00:06.40`；其 `[Events]` 段由 `Format:` 行定义字段顺序，`Dialogue:` 行承载数据，且字幕正文内可含 `{...}` 覆盖标签（如 `{\an8}`、`{\fad(200,200)}`）与 `\N` 换行符。

### 2.2 关键技术点

1. **状态机解析（State Machine）**
   使用 `in_events_section` 标志位逐行扫描，仅在进入 `[Events]` 段后才处理 `Format:`/`Dialogue:` 行，对脚本头（`[Script Info]`、`[V4+ Styles]`）等无关段落直接跳过，保证鲁棒性。

2. **动态字段映射（Format 行解析）**
   `Format:` 行决定 `Dialogue:` 的列顺序。解析器构造 `format_map = {field_name: index}`，再据此索引取值，**不写死列号**，兼容不同 ASS 变体。

3. **安全分割（防逗号误切）**
   ```python
   parts = line.split(':', 1)[1].strip().split(',', len(format_map) - 1)
   ```
   用 `maxsplit = 字段数 - 1` 限定分割次数，确保**仅 Text 字段之前**被切分，Text 内部的逗号不被破坏。

4. **时间格式转换 ASS → SRT**
   - ASS: `H:MM:SS.cc`（厘秒，2 位）
   - SRT: `HH:MM:SS,mmm`（毫秒，3 位）
   - 实现：`zfill(2)` 补齐小时位、`ljust(3, '0')` 把厘秒右补零为毫秒、小数点 `.` 换为逗号 `,`。

5. **覆盖标签清洗**
   ```python
   clean_text = re.sub(r'\{.*?\}', '', raw_text)   # 剥离 {\an8} {\fad(...)} 等
   clean_text = clean_text.replace('\\N', '\n').replace('\\n', '\n')
   ```
   非贪婪正则 `.*?` 精确匹配单组花括号内容，避免跨标签误删。

6. **编码兼容**：`utf-8-sig` 自动吞掉 BOM 头。

7. **容错**：单行解析失败仅 `logger.warning` 并跳过，不中断整体流程。

---

## 三、ASS / SRT ↔ Excel 转换的技术实现

源文件：`parsers/srt_parser.py`、`parsers/xlsx_parser.py`、`writers/`

### 3.1 SRT 解析

- 基于**正则 + `re.DOTALL`** 的块匹配，一次 `findall` 提取全部字幕块：
  ```python
  r'(\d+)\n(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})\n(.*?)(?:\n\n|\n?$)'
  ```
  四个捕获组分别对应：序号、开始时间、结束时间、正文。`\n\n` 作为块分隔符，兼容文件末尾缺空行的情况。

### 3.2 Excel 解析（xlsx_parser.py）

- **openpyxl 流式只读**：`load_workbook(read_only=True)` + `iter_rows(values_only=True)`，避免大表全量载入内存。
- **表头契约校验**：仅校验前 4 列等于 `["序号","开始时间","结束时间","字幕内容"]`，**容忍冗余列**（向后兼容用户自加的备注列）。
- **空行/缺列过滤**：`any(cell is not None)` 判空，列数 < 4 跳过并告警。
- **类型归一化**：单元格可能是 `int/datetime`，统一 `str()` 转为字符串，空值降级为 `""`。

### 3.3 Excel 写出

- 用 openpyxl 按 `EXCEL_HEADERS` 写表头，随后逐行写入 IR，保证「解析‑写出」**幂等往返**（Excel → SRT → Excel 不丢字段）。

### 3.4 转换矩阵（`conversion_type` 派发）

| conversion_type | 输入 | 输出 | 路径 |
| --- | --- | --- | --- |
| `subtitle_to_excel` | .srt/.ass | .xlsx | parse_srt / parse_ass → write_to_excel |
| `ass_to_srt` | .ass | .srt | parse_ass → write_to_srt |
| `xlsx_to_srt` | .xlsx | .srt | parse_xlsx → write_to_srt |

---

## 四、SUP (PGS) 图形字幕 → SRT/Excel 的技术实现

这是全站**最复杂**的链路，涉及二进制图形字幕解析 + OCR。

源文件：`parsers/sup_parser.py`、`ocr/engine.py`、`ocr/language_detector.py`

### 4.1 PGS 格式背景

`.sup` 是 Blu‑ray 的 **PGS (Presentation Graphic Stream)** 字幕，本质是**位图字幕**——存的不是文字，而是 RLE 压缩的像素图。其结构由若干 Segment 组成：

- **PCS** (Presentation Composition Segment)：显示控制，含 PTS 时间戳
- **PDS** (Palette Definition Segment)：调色板（YCbCr+Alpha）
- **ODS** (Object Definition Segment)：RLE 编码的图像数据

因此要把 SUP 变成文本字幕，必须**重建位图 → OCR 识别**。

### 4.2 位图重建

- `PGSReader` 读取 `displaysets`（每个 DisplaySet = 一帧字幕的段集合）
- `imagemaker.make_image(ods, pds)`：用 ODS 的 RLE 数据 + PDS 调色板**解码还原图像**为 PIL Image

### 4.3 时间轴提取

- `start_pts = pcs.pts`（PGS Reader 输出单位为**毫秒**）
- 结束时间取**下一个 DisplaySet 的 PCS.pts**；若下一帧缺 PCS，回退 `start+2000ms` 并向后扫描最近有效帧做 `min()` 防重叠；末帧默认显示 2 秒
- `_convert_pgs_timestamp_to_srt()`：毫秒整数 → `HH:MM:SS,mmm`

### 4.4 OCR 引擎：TorchfreeOCR（关键技术决策）

> 依赖：`torchfree_ocr==1.1.0`，注释明确写道「使用 TorchfreeOCR 替代 PyTorch」。

- **TorchfreeOCR 是 EasyOCR 的去 PyTorch 化重实现**，推理后端切换为 **ONNX Runtime**，模型以 ONNX 格式存放于 `/models`。
- 价值：**大幅缩减部署体积与依赖**（无需 CUDA/PyTorch 几百 MB 栈），适合轻量容器化部署。
- 模型路径通过环境变量 `EASYOCR_MODULE_PATH` / `MODULE_PATH` + `~/.TorchfreeOCR` 软链接多重注入，确保 Reader 从项目目录加载预置模型。

`SupOcrEngine` 封装：
```python
self.reader = ocr_module.Reader(lang_list=self.language_codes, recognizer=True)
results = self.reader.readtext(image_array, detail=1)  # [(bbox, text, confidence), ...]
```

### 4.5 图像预处理（提升识别率）

1. **RGBA → RGB**：以白色背景 + Alpha 通道作 mask 合成，消除透明通道干扰
2. **尺寸标准化**：宽 < 200 或高 < 50 时按 `max(2, ...)` 倍率**放大**，并用 `Image.LANCZOS` 高质量重采样——OCR 对低分辨率极敏感
3. **结果后处理**：置信度阈值 `> 0.5` 过滤、`re.sub(r'\s+',' ')` 折叠多余空白

### 4.6 帧去重 / OCR 缓存（性能优化）

PGS 字幕常有大量**静态重复帧**（同一句显示多帧）。`_frame_ocr_key()` 生成缓存键：

```python
h = hashlib.blake2b(digest_size=16)
h.update(bytes(ods.img_data))                 # RLE 像素字节
h.update(ods.width.to_bytes(2,'big'))         # 尺寸
h.update(ods.height.to_bytes(2,'big'))
for entry in pds.palette:
    h.update(bytes((entry.Y, entry.Alpha)))   # 调色板亮度+Alpha 指纹
```

- 用 **BLAKE2b** 对「RLE 数据 + 尺寸 + 调色板指纹」哈希，相同帧直接命中缓存，**避免重复 OCR**。
- 调色板指纹只取 `Y`（亮度）和 `Alpha`，因为这两者决定「文字 vs 背景」的视觉映射，既区分性强又开销极低。

### 4.7 语言自动检测（`language_detector.py`）

1. 取前 20 帧样本图像，用 `ch_sim + en` 先做一轮 OCR
2. **字符集启发式判定**：
   - `[\u4e00-\u9fff]` 命中 → 计中文
   - `[a-zA-Z]` 命中 → 计英文
3. 据此返回 `['ch_sim','en']` / `['ch_sim']` / `['en']`，未命中则回退默认
4. 用户也可手动选语言（前端语言下拉）

支持语言：简/繁中文、英、日、韩、泰、阿拉伯、印地、孟加拉、泰米尔、泰卢固、卡纳达、德、法、俄、西里尔。

### 4.8 两条 SUP 解析路径

| 函数 | 是否 OCR | 用途 |
| --- | --- | --- |
| `parse_sup_to_srt_structure` | 是 | SUP→SRT/Excel，需识别文字 |
| `parse_sup_timeline_only` | **否** | 仅提取时间轴，文本留空——**专供自动打轴**，速度数量级提升 |

---

## 五、空白字幕自动打轴（自动口述稿）的技术实现

> 源文件：`subtitle_converter.py` → `generate_narration_timing()` + `_split_long_segment()`
> conversion_type = `auto_narration_timing`

这是该工具最具领域特色、算法性最强的功能。

### 5.1 业务背景

口述影像（Audio Description）需要把解说词插入到**影片对白之间的静音空白段**。创作者拿到对白字幕后，需要在这些空白处预先「打好轴」（生成时间码占位条），再填入解说文本。手动打轴极其繁琐，本功能将其自动化。

### 5.2 算法核心思想

把对白字幕视作「占据时间段」，则相邻对白之间天然存在**空白间隙（gap）**。算法即：**枚举所有合法空白间隙 → 生成占位字幕条**。

### 5.3 算法步骤

**第 0 步：时间统一为毫秒**
- `srt_time_to_ms("HH:MM:SS,mmm")` → 整数毫秒，作为全流程统一时间度量，避免浮点与字符串比较。

**第 1 步：时间轴合法性校验**
- 单条：`end >= start`，否则抛 `SubtitleConverterError`
- 相邻：`cur_start >= prev_start`（防乱序）且 `cur_start >= prev_end`（防重叠）
- 任一不通过即报「字幕时间轴存在重叠或乱序，无法生成口述稿」——**保证后续 gap 计算单调**

**第 2 步：收集原始空白间隙 `raw_gaps`**
- **片头间隙**：`[00:00:00,  subtitles[0].start - GAP]`
- **对白间间隙**：`[subtitles[i].end + GAP,  subtitles[i+1].start - GAP]`（i 从 0 到 n‑2）
- **片尾不生成**（口述稿不落在最后一条对白之后）
- 其中 `GAP = NARRATION_GAP_MS = 500ms`，是对白与口述稿之间的**安全缓冲**，避免解说压到对白尾音/首音。

**第 3 步：最短时长过滤**
- 仅保留 `gap_end - gap_start >= NARRATION_MIN_DURATION_MS`（1000ms）的间隙
- 过短的空白塞不下解说，直接丢弃。

**第 4 步：超长段等分拆分（`_split_long_segment`）**
- 当 `gap 时长 > NARRATION_MAX_DURATION_MS`（30000ms）时触发：
  - 段数 `N = ceil(时长 / 30000)`
  - 扣除段间间隔后等分：`segment_duration = (时长 - 500*(N-1)) / N`
  - 相邻子段间留 `NARRATION_SPLIT_GAP_MS = 500ms` 间隔
  - 最后一段吸收除法余数，延伸到原始 end
- 拆分目的：避免单条口述稿过长（超过 30 秒），便于创作者分段填词与播音节奏控制。

**第 5 步：生成占位字幕条**
- 每段输出 `[新序号, ms_to_srt_time(seg_start), ms_to_srt_time(seg_end), "请填写口述文本"]`
- 序号从 1 重新编排，文本为占位符（前端 `narration_placeholder` 可随语言切换）

### 5.4 算法参数总览（`constants.py`）

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `NARRATION_GAP_MS` | 500 ms | 口述稿与前后对白的最小安全间隔 |
| `NARRATION_SPLIT_GAP_MS` | 500 ms | 超长段拆分后子段间的间隔 |
| `NARRATION_MIN_DURATION_MS` | 1000 ms | 单条口述稿最短持续时间（过滤过短空白） |
| `NARRATION_MAX_DURATION_MS` | 30000 ms | 单条口述稿最长持续时间（超限则等分拆分） |

### 5.5 与 SUP 的协同优化

当输入是 `.sup` 时，打轴走 `parse_sup_timeline_only`——**跳过 OCR**，只解析 PCS 时间戳。因为打轴只需要「对白出现/消失的时间点」，不需要对白文字内容。这一优化把 SUP 打轴从「分钟级 OCR」降到「秒级解析」。

---

## 六、Web 服务与工程实现

源文件：`app.py`

### 6.1 接口设计

- `GET /`：返回前端单页 `index.html`
- `/static/*`：FastAPI `StaticFiles` 挂载静态资源
- 转换接口：`multipart/form-data` 上传文件 + `conversion_type` + 可选 `placeholder_text` / `target_language`
- 响应：`FileResponse` 下发转换产物；`StreamingResponse` 推送进度

### 6.2 长任务与进度推送

- **后台任务**：`BackgroundTasks` 承载 SUP/OCR 等耗时转换
- **进度状态**：全局字典 `conversion_progress`（注释注明生产应换 Redis）以 `X-Task-ID` 头返回任务 ID，前端轮询/SSE 拉取进度
- 进度回调签名：`callback(current, total, message, phase=..., percentage=..., subtitle_count=...)`，分阶段（`file_parsing` / `language_detection` / `ocr_init` / `timeline_parsing` / `complete`）上报

### 6.3 临时文件管理

- `tempfile` + `uuid` 生成隔离的工作目录，`shutil` 在 finally 清理，避免并发任务串扰与磁盘泄漏

### 6.4 前端（`app.js` + Bootstrap）

- 文件选择后按扩展名动态填充 `conversionType` 下拉项（`ass_to_srt` / `subtitle_to_excel` / `xlsx_to_srt` / `sup_to_srt` / `sup_to_excel` / `auto_narration_timing`）
- `auto_narration_timing` 时附带 `placeholder_text`（随当前语言切换）
- SUP 相关转换与 SUP 打轴走「长任务 + 进度条」分支
- `data-i18n` 属性 + `languageManager` 实现中英双语切换

### 6.5 异常体系

自定义异常分层，便于上层精确捕获与用户提示：
`SubtitleConverterError`（基类）← `ParseError` / `WriteError` / `SupParseError` / `OcrRecognitionError` / `OnnxRuntimeError`

---

## 七、技术亮点小结

1. **统一 IR 管线**：`List[List[str]]` 中间表示让 4 进 4 出的格式矩阵只需 N+M 个适配器，而非 N×M。
2. **PyTorch‑Free OCR**：用 ONNX 版 EasyOCR 替换 PyTorch 栈，显著降低部署成本，是全站能轻量化跑起图形字幕识别的关键。
3. **内容哈希帧去重**：BLAKE2b + 调色板指纹的 OCR 缓存，针对 PGS 静态重复帧带来数量级加速。
4. **打轴专用快路径**：`parse_sup_timeline_only` 绕开 OCR，把 SUP 打轴从分钟级降到秒级。
5. **领域驱动算法**：`generate_narration_timing` 的 gap 枚举 + 最短过滤 + 超长等分拆分，是专为口述影像工作流设计的打轴算法，而非通用字幕工具的通用逻辑。
6. **鲁棒解析**：状态机 ASS、正则 SRT、流式 Excel、容错单行跳过 + BOM 兼容，工程细节扎实。

---

## 八、可复用到「准准阶段总流程串联平台」的技术资产

结合您要搭建「串联整个准备阶段总流程」的工具这一目标，本站可直接借鉴的技术模块：

| 能力 | 可复用资产 | 扩展方向 |
| --- | --- | --- |
| 多格式字幕互转 | Parser/Writer + IR 架构 | 新增 `.vtt` `.lrc` `.itt` `.stl` 解析器即可接入 |
| 时间轴统一处理 | `srt_time_to_ms` / `ms_to_srt_time` | 作为全平台时间基准 |
| 图形字幕数字化 | PGS 解析 + TorchfreeOCR + 帧去重 | 扩展支持 DVD `.sub/.idx`、`VOBsub` |
| 空白打轴 | `generate_narration_timing` 算法 | 参数化 GAP/MIN/MAX，支持「人物语音检测」替代纯字幕 gap |
| 长任务进度推送 | FastAPI BackgroundTasks + 进度字典 | 升级为 Celery/RQ + Redis，支持分布式 |
| 前端表单 + i18n | Bootstrap + data-i18n | 演进为组件化前端（Vue/React）接入多步流程编排 |

> 该平台当前是**单文件转换工具**（一次一文件、一次一转换类型）。要升级为「串联整个准准阶段总流程」的流水线工具，建议在其 IR 与 Parser/Writer 抽象之上，引入**任务 DAG 编排层**（如 Prefect / Airflow / 自研状态机），把「转格式 → 打轴 → OCR 校对 → 导出」串成可编排、可断点续跑的工作流。这正印证了您所述「肯定是不局限于目前现有的技术和功能的」——其现有架构提供了良好的扩展地基，但流程编排能力需在其之上新增。
