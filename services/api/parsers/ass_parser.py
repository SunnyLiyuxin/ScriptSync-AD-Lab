"""
ASS 字幕解析器
直接复用 ScriptGrid 的 parsers/ass_parser.py 验证过的逻辑
解析 .ass 文件为统一内部数据结构 [[index, start, end, text], ...]
"""
import re
import logging

logger = logging.getLogger(__name__)


def _convert_ass_time_to_srt(ass_time):
    """ASS 时间 H:MM:SS.cc → SRT 时间 HH:MM:SS,mmm"""
    try:
        hms_part, cs_part = ass_time.split('.')
        time_components = hms_part.split(':')
        h = time_components[0].zfill(2)
        m = time_components[1].zfill(2)
        s = time_components[2].zfill(2)
        ms_part = cs_part.ljust(3, '0')
        return f"{h}:{m}:{s},{ms_part}"
    except Exception:
        return ass_time


def parse_ass_to_srt_structure(file_path):
    """
    解析 .ass 文件为 SRT 标准数据结构。
    状态机解析 [Events] 段，Format 行动态映射字段位置。
    :return: [[序号, 开始时间, 结束时间, 字幕内容], ...]
    """
    data = []
    try:
        with open(file_path, 'r', encoding='utf-8-sig') as f:
            lines = f.readlines()
    except Exception as e:
        raise ValueError(f"读取 ASS 文件 '{file_path}' 时出错: {e}") from e

    in_events_section = False
    format_map = {}
    dialogue_count = 1

    for line in lines:
        line = line.strip()
        if line.lower() == '[events]':
            in_events_section = True
            continue
        if not in_events_section:
            continue
        if line.lower().startswith('format:'):
            fields = [field.strip().lower() for field in line.split(':', 1)[1].split(',')]
            format_map = {field: i for i, field in enumerate(fields)}
            if 'start' not in format_map or 'end' not in format_map or 'text' not in format_map:
                raise ValueError("ASS 'Format' 行缺少 Start, End, 或 Text 关键字段。")
        elif line.lower().startswith('dialogue:') and format_map:
            try:
                parts = line.split(':', 1)[1].strip().split(',', len(format_map) - 1)
                ass_start_time = parts[format_map['start']]
                ass_end_time = parts[format_map['end']]
                start_time = _convert_ass_time_to_srt(ass_start_time)
                end_time = _convert_ass_time_to_srt(ass_end_time)
                raw_text = parts[format_map['text']]
                clean_text = re.sub(r'\{.*?\}', '', raw_text)
                clean_text = clean_text.replace('\\N', '\n').replace('\\n', '\n')
                data.append([str(dialogue_count), start_time, end_time, clean_text])
                dialogue_count += 1
            except (IndexError, KeyError) as e:
                logger.warning(f"Dialogue 行字段不完整或格式错误,已跳过: {line}. 错误: {e}")
                continue
    return data


def parse_ass_to_events(file_path):
    """
    解析 .ass 文件为前端 AssEvent 兼容结构（含 layer/style/name 等完整字段）
    :return: [{id, layer, start, end, style, name, text, _status, ...}, ...]
    """
    import uuid
    events = []
    try:
        with open(file_path, 'r', encoding='utf-8-sig') as f:
            lines = f.readlines()
    except Exception as e:
        raise ValueError(f"读取 ASS 文件 '{file_path}' 时出错: {e}") from e

    in_events_section = False
    format_map = {}
    format_field_count = 10

    for line in lines:
        line = line.strip()
        if not line:
            continue
        if line.lower() == '[events]':
            in_events_section = True
            continue
        if not in_events_section:
            continue
        if line.lower().startswith('format:'):
            fields = [f.strip().lower() for f in line.replace('format:', '', 1).split(',')]
            format_field_count = len(fields)
            format_map = {f: i for i, f in enumerate(fields)}
        elif line.lower().startswith('dialogue:') or line.lower().startswith('comment:'):
            is_comment = line.lower().startswith('comment:')
            content = re.sub(r'^(dialogue|comment):\s*', '', line, flags=re.IGNORECASE)
            parts = []
            remaining = content
            for _ in range(format_field_count - 1):
                idx = remaining.find(',')
                if idx == -1:
                    break
                parts.append(remaining[:idx])
                remaining = remaining[idx + 1:]
            parts.append(remaining)

            layer_idx = format_map.get('layer', 0)
            start_idx = format_map.get('start', 1)
            end_idx = format_map.get('end', 2)
            style_idx = format_map.get('style', 3)
            name_idx = format_map.get('name', 4)
            text_idx = format_field_count - 1

            def ass_to_sec(t):
                import re as _re
                m = _re.match(r'^(\d+):(\d{2}):(\d{2})\.(\d{2})$', t.strip())
                if not m:
                    return 0.0
                return int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3]) + int(m[4]) / 100

            events.append({
                'id': str(uuid.uuid4()),
                'layer': int(parts[layer_idx]) if parts[layer_idx].isdigit() else 0,
                'start': ass_to_sec(parts[start_idx]),
                'end': ass_to_sec(parts[end_idx]),
                'style': parts[style_idx] if style_idx < len(parts) else 'Default',
                'name': parts[name_idx] if name_idx < len(parts) else '',
                'text': parts[text_idx] if text_idx < len(parts) else '',
                '_status': 'deleted' if is_comment else 'draft',
                '_lockedBy': None,
                '_assignedTo': None,
            })
    return events
