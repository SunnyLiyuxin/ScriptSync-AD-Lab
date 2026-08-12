"""
异步字幕转换任务（MVP：内存任务表）

- convert_subtitle_async(task_id, file_path, target_format, background_tasks)
    用 FastAPI BackgroundTasks 跑 SUP OCR 等慢任务，
    返回 {task_id, status, result_url}
- get_task_status(task_id)
    查询任务状态，返回 {task_id, status, result_url, error?}

任务状态：'pending' | 'running' | 'completed' | 'failed'
任务结果以 JSON 文件落盘，result_url 指向该文件路径（MVP 本地模式）。
"""
import os
import json
import logging
from pathlib import Path
from fastapi import BackgroundTasks

logger = logging.getLogger(__name__)

UPLOAD_DIR = Path(os.getenv('UPLOAD_DIR', '/tmp/scriptsync-uploads'))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
TASK_RESULT_DIR = Path(os.getenv('TASK_RESULT_DIR', str(UPLOAD_DIR / 'tasks')))
TASK_RESULT_DIR.mkdir(parents=True, exist_ok=True)

# 内存任务表（MVP 阶段够用；生产换 Redis/DB）
_tasks = {}


def _set_task(task_id, status, result_url=None, error=None):
    _tasks[task_id] = {
        'task_id': task_id,
        'status': status,
        'result_url': result_url,
        'error': error,
    }


def get_task_status(task_id):
    """查询任务状态"""
    task = _tasks.get(task_id)
    if not task:
        return {'task_id': task_id, 'status': 'unknown', 'result_url': None}
    return dict(task)


def _run_sup_ocr(task_id, file_path):
    """后台执行 SUP OCR（同步函数，由 BackgroundTasks 调度）"""
    _set_task(task_id, 'running')
    try:
        # 延迟导入，避免循环依赖 & 启动期开销
        from parsers.sup_parser import parse_sup
        result = parse_sup(file_path)
        result_path = TASK_RESULT_DIR / f"{task_id}.json"
        with open(result_path, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False)
        _set_task(task_id, 'completed', result_url=str(result_path))
        logger.info(f"SUP OCR 任务 {task_id} 完成 → {result_path}")
    except Exception as e:
        logger.exception(f"SUP OCR 任务 {task_id} 失败")
        _set_task(task_id, 'failed', error=str(e))


def _run_convert(task_id, file_path, target_format):
    """后台执行通用字幕转换（ass/srt/xlsx → srt/xlsx/vtt/webvtt）"""
    _set_task(task_id, 'running')
    try:
        from parsers import parse_ass_to_srt_structure, parse_srt, parse_xlsx
        from writers import write_to_srt, write_to_excel
        from writers.vtt_writer import write_to_vtt

        suffix = Path(file_path).suffix.lower()
        if suffix == '.ass':
            data = parse_ass_to_srt_structure(file_path)
        elif suffix == '.srt':
            data = parse_srt(file_path)
        elif suffix == '.xlsx':
            data = parse_xlsx(file_path)
        else:
            raise ValueError(f"unsupported input format: {suffix}")

        out_path = TASK_RESULT_DIR / f"{task_id}.{target_format}"
        fmt = target_format.lower()
        if fmt == 'srt':
            write_to_srt(data, str(out_path))
        elif fmt == 'xlsx':
            write_to_excel(data, str(out_path))
        elif fmt in ('vtt', 'webvtt'):
            write_to_vtt(data, str(out_path))
        else:
            raise ValueError(f"unsupported target format: {target_format}")

        _set_task(task_id, 'completed', result_url=str(out_path))
        logger.info(f"转换任务 {task_id} 完成 → {out_path}")
    except Exception as e:
        logger.exception(f"转换任务 {task_id} 失败")
        _set_task(task_id, 'failed', error=str(e))


def convert_subtitle_async(task_id, file_path, target_format, background_tasks):
    """
    触发异步字幕转换。

    :param task_id: 任务 ID（由调用方生成）
    :param file_path: 已落盘的源文件路径
    :param target_format: 目标格式（'sup-ocr' / 'srt' / 'xlsx' / 'vtt' / 'webvtt'）
    :param background_tasks: FastAPI BackgroundTasks 实例
    :return: {task_id, status, result_url}
    """
    _set_task(task_id, 'pending', result_url=None)
    fmt = (target_format or '').lower()

    if fmt in ('sup-ocr', 'sup', 'ocr'):
        background_tasks.add_task(_run_sup_ocr, task_id, file_path)
        return {'task_id': task_id, 'status': 'pending', 'result_url': None}

    if fmt in ('srt', 'xlsx', 'vtt', 'webvtt'):
        background_tasks.add_task(_run_convert, task_id, file_path, fmt)
        return {'task_id': task_id, 'status': 'pending', 'result_url': None}

    _set_task(task_id, 'failed', error=f"unsupported async target format: {target_format}")
    return {'task_id': task_id, 'status': 'failed', 'result_url': None}
