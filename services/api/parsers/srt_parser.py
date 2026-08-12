"""
SRT 字幕解析器
直接复用 ScriptGrid 的 parsers/srt_parser.py 逻辑
"""
import re
import logging

logger = logging.getLogger(__name__)


def parse_srt(file_path):
    """
    解析 .srt 字幕文件
    :return: [[序号, 开始时间, 结束时间, 字幕内容], ...]
    """
    try:
        with open(file_path, 'r', encoding='utf-8-sig') as f:
            content = f.read()
        pattern = re.compile(
            r'(\d+)\n(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})\n(.*?)(?:\n\n|\n?$)',
            re.DOTALL,
        )
        matches = pattern.findall(content)
        data = []
        for match in matches:
            index = match[0]
            start_time = match[1]
            end_time = match[2]
            text = match[3].replace('\r\n', '\n')
            data.append([index, start_time, end_time, text])
        return data
    except Exception as e:
        raise ValueError(f"解析 SRT 文件 '{file_path}' 时出错: {e}") from e
