"""WebVTT 写入器

把 events 列表导出为 WebVTT 格式字符串/文件。
events 兼容两种形态：
  - dict 列表：[{start, end, text}, ...]（start/end 可为秒数 float 或 'HH:MM:SS,mmm' 字符串）
  - SRT 行结构：[[idx, start, end, text], ...]
WebVTT 时间格式：HH:MM:SS.mmm（点分隔毫秒，与 SRT 逗号分隔不同）
"""
import re


def _strip_ass_tags(text):
    """剥离 ASS 内联标签 {\\xxx}"""
    return re.sub(r'\{.*?\}', '', text)


def _format_vtt_time(t):
    """把秒数或 SRT/ASS 时间字符串格式化为 WebVTT 时间 HH:MM:SS.mmm"""
    if isinstance(t, (int, float)):
        total_ms = int(round(float(t) * 1000))
        if total_ms < 0:
            total_ms = 0
        h = total_ms // 3600000
        m = (total_ms % 3600000) // 60000
        s = (total_ms % 60000) // 1000
        ms = total_ms % 1000
        return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"
    # 字符串：可能是 'HH:MM:SS,mmm'(SRT) 或 'H:MM:SS.cc'(ASS)
    t = str(t).strip()
    if ',' in t:
        t = t.replace(',', '.', 1)
    parts = t.split(':')
    if len(parts) == 3:
        h, m, rest = parts
        if '.' in rest:
            s, ms = rest.split('.', 1)
        else:
            s, ms = rest, '0'
        try:
            return f"{int(h):02d}:{int(m):02d}:{int(s):02d}.{ms.ljust(3, '0')[:3]}"
        except ValueError:
            return t
    return t


def events_to_vtt(events):
    """
    events: list[dict|list]
    返回 WebVTT 格式字符串。
    """
    lines = ['WEBVTT', '']
    for ev in events:
        if isinstance(ev, dict):
            start = ev.get('start', 0)
            end = ev.get('end', 0)
            text = ev.get('text', '')
        else:
            # 兼容 [idx, start, end, text]
            start = ev[1] if len(ev) > 1 else 0
            end = ev[2] if len(ev) > 2 else 0
            text = ev[3] if len(ev) > 3 else ''
        text = _strip_ass_tags(str(text))
        text = text.replace('\\N', '\n').replace('\\n', '\n')
        lines.append(f"{_format_vtt_time(start)} --> {_format_vtt_time(end)}")
        lines.append(text)
        lines.append('')
    return '\n'.join(lines)


def write_to_vtt(events, output_path):
    """把 events 列表写为 WebVTT 文件"""
    try:
        vtt_str = events_to_vtt(events)
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(vtt_str)
    except Exception as e:
        raise ValueError(f"写入 WebVTT 文件时出错: {e}") from e
