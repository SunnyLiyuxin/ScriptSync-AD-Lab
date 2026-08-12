"""
SUP (PGS 图形字幕) OCR 解析器

SUP 是 Blu-ray PGS (Presentation Graphic Stream) 二进制图形字幕。
本解析器：
  1. 优先尝试 pgsreader 库解析 PCS/PDS/ODS 段并重建位图（若已安装）
  2. 否则用内置 PGS 段解析器（无外部依赖）解析 PCS/PDS/ODS，重建位图
  3. 对每帧位图调用 dashscope MultiModalConversation OCR
     （若 dashscope 未安装 / 无 API Key / 无图像库，fallback 到只提取时间码、返回空文本）
  4. 输出与 ass_parser.parse_ass_to_events 兼容的结构：
     {scriptInfo, styles, events:[{layer, start, end, style, name, text}, ...]}

时间码取自 PCS 段的 PTS（90kHz 时钟），转为秒。
"""
import io
import os
import re
import struct
import logging
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)

DASHSCOPE_API_KEY = os.getenv('DASHSCOPE_API_KEY', '')
OCR_MODEL = os.getenv('SUP_OCR_MODEL', 'qwen-vl-plus')

# PGS 段类型
SEG_PCS = 0x16  # Presentation Composition Segment
SEG_WDS = 0x17  # Window Definition Segment
SEG_PDS = 0x18  # Palette Definition Segment
SEG_ODS = 0x19  # Object Definition Segment
SEG_END = 0x80  # End of Display Set

# PCS composition_state
CS_NORMAL = 0x00
CS_ACQUISITION = 0x40
CS_EPOCH_START = 0x80


# ============ PGS 二进制解析（内置，无外部依赖）============

def _pts_to_seconds(pts):
    """PTS（90kHz 时钟值）→ 秒"""
    try:
        return float(pts) / 90000.0
    except (TypeError, ValueError):
        return 0.0


def _parse_pgs_segments(data):
    """
    解析 PGS 二进制流为段列表。
    每段：{'pts': int, 'dts': int, 'type': int, 'size': int, 'data': bytes}
    段头 13 字节：magic(2, 'PG') + PTS(4, BE) + DTS(4, BE) + type(1) + size(2, BE)
    """
    segments = []
    offset = 0
    n = len(data)
    while offset + 13 <= n:
        if data[offset] != 0x50 or data[offset + 1] != 0x47:
            # 失步：向前扫描直到找到 'PG'
            offset += 1
            continue
        pts = struct.unpack('>I', data[offset + 2:offset + 6])[0]
        dts = struct.unpack('>I', data[offset + 6:offset + 10])[0]
        seg_type = data[offset + 10]
        seg_size = struct.unpack('>H', data[offset + 11:offset + 13])[0]
        seg_data = data[offset + 13:offset + 13 + seg_size]
        segments.append({
            'pts': pts, 'dts': dts, 'type': seg_type,
            'size': seg_size, 'data': seg_data,
        })
        offset += 13 + seg_size
    return segments


def _group_display_sets(segments):
    """
    以 END(0x80) 段为分隔，把连续段归为一个 display set。
    每个 display set 通常包含一个 PCS、若干 PDS、若干 ODS、END。
    """
    sets = []
    current = []
    for seg in segments:
        current.append(seg)
        if seg['type'] == SEG_END:
            sets.append(current)
            current = []
    if current:
        sets.append(current)
    return sets


def _parse_pcs(seg_data):
    """解析 PCS 段，返回 dict（含 composition_state / objects 位置等）"""
    if len(seg_data) < 11:
        return None
    video_width = struct.unpack('>H', seg_data[0:2])[0]
    video_height = struct.unpack('>H', seg_data[2:4])[0]
    frame_rate = seg_data[4]
    composition_number = struct.unpack('>H', seg_data[5:7])[0]
    composition_state = seg_data[7]
    palette_update_flag = seg_data[8] & 0x80
    palette_id_ref = seg_data[9]
    object_count = seg_data[10]
    objects = []
    pos = 11
    for _ in range(object_count):
        if pos + 8 > len(seg_data):
            break
        obj_id = struct.unpack('>H', seg_data[pos:pos + 2])[0]
        window_id = seg_data[pos + 2]
        cropped_flag = seg_data[pos + 3]
        obj_h = struct.unpack('>H', seg_data[pos + 4:pos + 6])[0]
        obj_v = struct.unpack('>H', seg_data[pos + 6:pos + 8])[0]
        objects.append({
            'object_id': obj_id, 'window_id': window_id,
            'h': obj_h, 'v': obj_v, 'cropped': bool(cropped_flag & 0x80),
        })
        pos += 8
        if cropped_flag & 0x80:
            pos += 8  # 裁剪信息 8 字节
    return {
        'video_width': video_width, 'video_height': video_height,
        'composition_state': composition_state,
        'palette_id': palette_id_ref,
        'palette_update': bool(palette_update_flag),
        'objects': objects,
    }


def _parse_pds(seg_data):
    """解析 PDS 段，返回 (palette_id, version, {entry_id: (R,G,B,A)})"""
    if len(seg_data) < 2:
        return None, None, {}
    palette_id = seg_data[0]
    version = seg_data[1]
    palette = {}
    pos = 2
    while pos + 5 <= len(seg_data):
        entry_id = seg_data[pos]
        Y = seg_data[pos + 1]
        Cr = seg_data[pos + 2]
        Cb = seg_data[pos + 3]
        A = seg_data[pos + 4]
        # YCrCb → RGB（BT.601）
        R = max(0, min(255, int(round(Y + 1.402 * (Cr - 128)))))
        G = max(0, min(255, int(round(Y - 0.344 * (Cb - 128) - 0.714 * (Cr - 128)))))
        B = max(0, min(255, int(round(Y + 1.772 * (Cb - 128)))))
        palette[entry_id] = (R, G, B, A)
        pos += 5
    return palette_id, version, palette


def _decode_rle(rle_data, width, height):
    """
    解码 PGS ODS 的 RLE 像素数据，返回二维 list（color index）。
    规则：
      b != 0       → color=b, run=1
      b == 0:
        b2 & 0x80  → run=(b2&0x3F), color=下一字节
        b2 & 0x40  → run=((b2&0x3F)<<8)|下一字节, color=再下一字节
        else       → run=(b2&0x3F), color=0；run==0 表示行结束
    """
    bitmap = [[0] * width for _ in range(height)]
    x, y = 0, 0
    i = 0
    n = len(rle_data)
    while y < height and i < n:
        b = rle_data[i]; i += 1
        if b != 0:
            color = b
            run = 1
        else:
            if i >= n:
                break
            b2 = rle_data[i]; i += 1
            if b2 & 0x80:
                run = b2 & 0x3F
                if i >= n:
                    break
                color = rle_data[i]; i += 1
            elif b2 & 0x40:
                if i >= n:
                    break
                b3 = rle_data[i]; i += 1
                run = ((b2 & 0x3F) << 8) | b3
                if i >= n:
                    break
                color = rle_data[i]; i += 1
            else:
                run = b2 & 0x3F
                color = 0
                if run == 0:
                    # 行结束
                    x = 0
                    y += 1
                    continue
        # 填充 run 个像素
        for _ in range(run):
            if 0 <= y < height and 0 <= x < width:
                bitmap[y][x] = color
            x += 1
        if x >= width:
            x = 0
            y += 1
    return bitmap


def _parse_ods_group(ods_segments):
    """
    解析同一 object 的一组 ODS 段（可能跨段），拼接 RLE 数据后解码。
    返回 {object_id, width, height, pixels} 或 None
    """
    if not ods_segments:
        return None
    object_id = struct.unpack('>H', ods_segments[0]['data'][0:2])[0]
    rle_buffer = bytearray()
    width = height = 0
    for ods in ods_segments:
        d = ods['data']
        if len(d) < 4:
            continue
        seq_desc = d[3]
        if seq_desc & 0x40:  # first in sequence
            if len(d) >= 8:
                width = struct.unpack('>H', d[4:6])[0]
                height = struct.unpack('>H', d[6:8])[0]
                rle_buffer.extend(d[8:])
            else:
                rle_buffer.extend(d[4:])
        else:
            rle_buffer.extend(d[4:])
    if width <= 0 or height <= 0:
        return None
    pixels = _decode_rle(bytes(rle_buffer), width, height)
    return {'object_id': object_id, 'width': width, 'height': height, 'pixels': pixels}


def _bitmap_to_png_bytes(bitmap, palette, width, height):
    """位图 + 调色板 → PNG bytes（需 PIL）；无 PIL 返回 None"""
    try:
        from PIL import Image
    except ImportError:
        return None
    img = Image.new('RGBA', (width, height))
    px = img.load()
    for y in range(height):
        row = bitmap[y]
        for x in range(width):
            idx = row[x]
            rgba = palette.get(idx, (0, 0, 0, 0))
            px[x, y] = rgba
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()


# ============ OCR（dashscope MultiModalConversation）============

def _ocr_image_png(png_bytes):
    """
    用 dashscope MultiModalConversation 识别 PNG 图片中的字幕文字。
    无 dashscope / 无 API Key / 调用失败 → 返回空字符串。
    """
    if not DASHSCOPE_API_KEY:
        return ''
    try:
        import dashscope
        from dashscope import MultiModalConversation
        dashscope.api_key = DASHSCOPE_API_KEY

        # 写入临时文件供 dashscope 本地读取
        tmp = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
        tmp.write(png_bytes)
        tmp.close()
        try:
            messages = [{
                'role': 'user',
                'content': [
                    {'image': f'file://{tmp.name}'},
                    {'text': '请识别这张图片中的字幕文字，只返回识别出的纯文本内容，不要任何解释或额外说明。若无文字请返回空。'},
                ],
            }]
            resp = MultiModalConversation.call(model=OCR_MODEL, messages=messages)
            if resp.status_code != 200:
                logger.warning(f"SUP OCR 调用失败: {resp.code} - {resp.message}")
                return ''
            content = resp.output.choices[0].message.content
            # content 可能是 [{'text': '...'}] 或字符串
            if isinstance(content, list):
                parts = []
                for c in content:
                    if isinstance(c, dict):
                        parts.append(c.get('text', ''))
                    else:
                        parts.append(str(c))
                return ''.join(parts).strip()
            return str(content).strip()
        finally:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass
    except Exception as e:
        logger.warning(f"SUP OCR 异常，返回空文本: {e}")
        return ''


def _ocr_display_set(display_set, pcs):
    """
    对一个 display set 重建位图并 OCR。失败/不可用 → 返回空字符串。
    """
    # 收集 PDS（取最后一个匹配 palette_id 的）
    palettes = {}
    for seg in display_set:
        if seg['type'] == SEG_PDS:
            pid, _ver, pal = _parse_pds(seg['data'])
            if pal:
                palettes[pid] = pal
    palette = palettes.get(pcs['palette_id']) or (palettes[list(palettes)[0]] if palettes else {})

    # 收集 ODS，按 object_id 分组
    ods_by_obj = {}
    for seg in display_set:
        if seg['type'] == SEG_ODS and len(seg['data']) >= 2:
            oid = struct.unpack('>H', seg['data'][0:2])[0]
            ods_by_obj.setdefault(oid, []).append(seg)

    if not ods_by_obj or not palette:
        return ''

    # 取 PCS 第一个 object 的位置和 id
    obj_info = pcs['objects'][0]
    obj = _parse_ods_group(ods_by_obj.get(obj_info['object_id'], []))
    if not obj:
        return ''
    png = _bitmap_to_png_bytes(obj['pixels'], palette, obj['width'], obj['height'])
    if not png:
        return ''
    return _ocr_image_png(png)


# ============ 主入口 ============

def parse_sup(file_path):
    """
    解析 SUP (PGS) 文件，返回与 ass_parser 一致的结构：
      {scriptInfo: {...}, styles: [...], events: [{layer, start, end, style, name, text}, ...]}

    start/end 为秒（float），text 为 OCR 结果（无 OCR 能力时为空字符串）。
    """
    try:
        with open(file_path, 'rb') as f:
            raw = f.read()
    except Exception as e:
        raise ValueError(f"读取 SUP 文件 '{file_path}' 时出错: {e}") from e

    # 优先尝试 pgsreader（若已安装），失败则用内置解析
    segments = None
    try:
        import pgsreader  # noqa: F401
        # pgsreader 不同版本 API 不一致，这里仍走内置段解析以保证稳定
        # （保留 import 以便未来按 pgsreader API 替换）
        segments = _parse_pgs_segments(raw)
    except ImportError:
        segments = _parse_pgs_segments(raw)
    except Exception as e:
        logger.warning(f"pgsreader 不可用，使用内置 PGS 解析: {e}")
        segments = _parse_pgs_segments(raw)

    display_sets = _group_display_sets(segments)

    # 解析视频尺寸（取首个 PCS）
    video_width = video_height = 0
    for ds in display_sets:
        for seg in ds:
            if seg['type'] == SEG_PCS:
                pcs0 = _parse_pcs(seg['data'])
                if pcs0:
                    video_width = pcs0['video_width']
                    video_height = pcs0['video_height']
                break
        if video_width:
            break

    events = []
    active = None  # 当前正在显示的事件（等待 clear 或被替换）

    for ds in display_sets:
        pcs_seg = None
        for seg in ds:
            if seg['type'] == SEG_PCS:
                pcs_seg = seg
                break
        if pcs_seg is None:
            continue
        pts_sec = _pts_to_seconds(pcs_seg['pts'])
        pcs = _parse_pcs(pcs_seg['data'])
        if not pcs:
            continue

        if pcs['objects']:
            # 新显示：先关闭上一个未结束的事件
            if active is not None and active['end'] is None:
                active['end'] = pts_sec
            text = _ocr_display_set(ds, pcs)
            active = {
                'layer': 0,
                'start': round(pts_sec, 3),
                'end': None,
                'style': 'Default',
                'name': '',
                'text': text,
            }
            events.append(active)
        else:
            # clear：结束当前显示
            if active is not None:
                active['end'] = round(pts_sec, 3)
                active = None

    # 收尾：未关闭的事件给默认时长 3 秒
    for ev in events:
        if ev['end'] is None or ev['end'] <= ev['start']:
            ev['end'] = round(ev['start'] + 3.0, 3)

    return {
        'scriptInfo': {
            'source': 'sup',
            'video_width': video_width,
            'video_height': video_height,
            'event_count': len(events),
        },
        'styles': [{
            'name': 'Default',
            'fontname': 'Arial',
            'fontsize': 24,
            'primary_colour': '&H00FFFFFF',
            'outline': 1,
        }],
        'events': events,
    }


def parse_sup_to_events(file_path):
    """便捷方法：仅返回 events 列表（与 parse_ass_to_events 一致的列表形态）"""
    return parse_sup(file_path)['events']


if __name__ == '__main__':
    import sys
    if len(sys.argv) < 2:
        print("usage: python sup_parser.py <file.sup>")
        sys.exit(1)
    import json
    print(json.dumps(parse_sup(sys.argv[1]), ensure_ascii=False, indent=2))
