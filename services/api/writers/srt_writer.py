"""SRT 写入器"""
from openpyxl import Workbook


def write_to_srt(data, output_path):
    """
    将 [[序号, 开始时间, 结束时间, 字幕内容], ...] 写为 SRT 文件
    """
    try:
        with open(output_path, 'w', encoding='utf-8') as f:
            for i, row in enumerate(data, 1):
                idx = row[0] if row[0] else str(i)
                start = row[1]
                end = row[2]
                text = row[3]
                f.write(f"{idx}\n{start} --> {end}\n{text}\n\n")
    except Exception as e:
        raise ValueError(f"写入 SRT 文件时出错: {e}") from e
