"""Excel 写入器"""
from openpyxl import Workbook

EXCEL_HEADERS = ["序号", "开始时间", "结束时间", "字幕内容"]
EXCEL_SHEET_NAME = "Sheet1"


def write_to_excel(data, output_path):
    """
    将 [[序号, 开始时间, 结束时间, 字幕内容], ...] 写为 xlsx 文件
    """
    try:
        wb = Workbook()
        ws = wb.active
        ws.title = EXCEL_SHEET_NAME
        ws.append(EXCEL_HEADERS)
        for row in data:
            ws.append(row[:4])
        wb.save(output_path)
    except Exception as e:
        raise ValueError(f"写入 Excel 文件时出错: {e}") from e
