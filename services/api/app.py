"""
ScriptSync API 主入口
- 项目 CRUD（SQLite，MVP 阶段，生产换 RDS）
- 字幕文件转换（复用 ScriptGrid 解析器）
- 协作 token 签发（JWT，与 Node.js 协作服务端共享 secret）
- AI 客观中性改写（V1.5，调百炼/精度优先模型）
"""
import os
import json
import time
import uuid
import sqlite3
import tempfile
import logging
from pathlib import Path
from typing import Optional

import jwt
from fastapi import FastAPI, File, UploadFile, HTTPException, Depends, Header, BackgroundTasks, Request, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from parsers import (
    parse_ass_to_srt_structure, parse_ass_to_events,
    parse_srt, parse_xlsx, parse_sup,
)
from writers import write_to_excel, write_to_srt, write_to_vtt
from ai import (
    check_objectivity, detect_subjective_rewrite,
    check_consistency, check_continuity,
    estimate_duration, check_duration_fit,
)
from ffmpeg import extract_waveform, detect_silence
from tasks import convert_subtitle_async, get_task_status

# 配置
JWT_SECRET = os.getenv('JWT_SECRET', 'scriptsync-dev-secret-change-in-prod')
DB_PATH = os.getenv('DB_PATH', '/tmp/scriptsync.db')
COLLAB_WS_URL = os.getenv('COLLAB_WS_URL', 'ws://localhost:1234')
UPLOAD_DIR = Path(os.getenv('UPLOAD_DIR', '/tmp/scriptsync-uploads'))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="ScriptSync API",
    description="口述稿全流程协作平台 API",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============ 数据库 ============

def get_db():
    """SQLite 连接（MVP），生产换 RDS"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        owner_id TEXT NOT NULL,
        created_at INTEGER,
        updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        role TEXT DEFAULT 'narrator',
        joined_at INTEGER,
        FOREIGN KEY (project_id) REFERENCES projects(id)
    );
    CREATE TABLE IF NOT EXISTS video_sources (
        project_id TEXT PRIMARY KEY,
        oss_key TEXT,
        filename TEXT,
        duration REAL DEFAULT 0,
        uploaded_by TEXT,
        uploaded_at INTEGER,
        FOREIGN KEY (project_id) REFERENCES projects(id)
    );
    CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        created_at INTEGER,
        created_by TEXT,
        label TEXT,
        size INTEGER,
        data TEXT,
        FOREIGN KEY (project_id) REFERENCES projects(id)
    );
    CREATE TABLE IF NOT EXISTS invitations (
        code TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER,
        expires_at INTEGER,
        max_uses INTEGER DEFAULT 0,
        use_count INTEGER DEFAULT 0,
        revoked INTEGER DEFAULT 0,
        role TEXT DEFAULT 'narrator',
        FOREIGN KEY (project_id) REFERENCES projects(id)
    );
    CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at INTEGER
    );
    """)
    conn.commit()
    # 兼容旧库：确保 invitations 表的列完整（老版本可能缺少某些列）
    _migrate_invitations_table(conn)
    conn.close()


def _migrate_invitations_table(conn):
    """迁移：检查 invitations 表列是否存在，缺失则补建"""
    try:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(invitations)").fetchall()}
        if not cols:
            return  # 表不存在，init_db 的 CREATE TABLE 会处理
        if 'role' not in cols:
            conn.execute("ALTER TABLE invitations ADD COLUMN role TEXT DEFAULT 'narrator'")
        if 'max_uses' not in cols:
            conn.execute("ALTER TABLE invitations ADD COLUMN max_uses INTEGER DEFAULT 0")
        if 'use_count' not in cols:
            conn.execute("ALTER TABLE invitations ADD COLUMN use_count INTEGER DEFAULT 0")
        if 'revoked' not in cols:
            conn.execute("ALTER TABLE invitations ADD COLUMN revoked INTEGER DEFAULT 0")
        conn.commit()
    except Exception as e:
        logger.warning(f"invitations 表迁移跳过: {e}")


init_db()


# ============ 鉴权 ============

def verify_token(authorization: Optional[str] = Header(None)) -> dict:
    """简易鉴权：从 Authorization header 提取 JWT"""
    if not authorization or not authorization.startswith('Bearer '):
        raise HTTPException(401, "Missing or invalid Authorization header")
    token = authorization.split(' ', 1)[1]
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=['HS256'])
    except jwt.PyJWTError:
        raise HTTPException(401, "Invalid token")


# ============ 角色权限矩阵 ============
# 角色：owner（统筹）/ manager（管理员，可分配工作）/ reviewer（审阅）/ narrator（口述员）
# MVP 不做 guest（只读观察者），V2 视需求补
VALID_ROLES = {'owner', 'manager', 'reviewer', 'narrator'}


def get_member_role(project_id: str, user_id: str) -> Optional[str]:
    """查询某用户在某项目中的角色，非成员返回 None"""
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT role FROM members WHERE project_id=? AND user_id=?",
            (project_id, user_id),
        ).fetchone()
        return row['role'] if row else None
    finally:
        conn.close()


def require_project_role(project_id_param: str, allowed_roles: set):
    """FastAPI 依赖工厂：校验当前用户在指定项目中具备允许的角色之一

    用法：
        @app.post("/api/projects/{project_id}/members")
        def add_member(project_id: str, ..., ctx: dict = Depends(require_project_role('project_id', {'owner', 'manager'}))):
            user = ctx['user']
            ...
    返回 {user, role} 供端点内使用。
    """
    def dependency(
        request: Request,
        user: dict = Depends(verify_token),
    ) -> dict:
        # 从路径参数取 project_id
        project_id = request.path_params.get(project_id_param)
        if not project_id:
            raise HTTPException(400, f"Missing path param: {project_id_param}")
        role = get_member_role(project_id, user['userId'])
        if role is None:
            raise HTTPException(403, "非项目成员")
        if role not in allowed_roles:
            raise HTTPException(403, f"权限不足（需要 {','.join(sorted(allowed_roles))}，当前 {role}）")
        return {'user': user, 'role': role}
    return dependency


# ============ Pydantic 模型 ============

class ProjectCreate(BaseModel):
    name: str
    description: str = ''


class ProjectMemberAdd(BaseModel):
    username: str
    role: str = 'narrator'
    user_id: Optional[str] = None  # 可选：MVP 阶段前端从 awareness 在线列表选用户时直接传 userId，避免占位 uuid 无法匹配真实身份


class ProjectMemberUpdate(BaseModel):
    role: str


class ProjectMemberRemove(BaseModel):
    """仅用于文档说明，DELETE 走路径参数"""


class BulkAssignRequest(BaseModel):
    """工作分配：批量指派（阶段4）"""
    event_ids: list[str]
    assignee_user_id: Optional[str] = None  # None = 解除指派


# ============ 项目 CRUD ============

@app.post("/api/projects")
def create_project(data: ProjectCreate, user: dict = Depends(verify_token)):
    """创建项目"""
    pid = str(uuid.uuid4())
    now = int(time.time())
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO projects (id, name, description, owner_id, created_at, updated_at) VALUES (?,?,?,?,?,?)",
            (pid, data.name, data.description, user['userId'], now, now),
        )
        # 创建者自动成为 owner 成员
        conn.execute(
            "INSERT INTO members (id, project_id, user_id, username, role, joined_at) VALUES (?,?,?,?,?,?)",
            (str(uuid.uuid4()), pid, user['userId'], user.get('username', ''), 'owner', now),
        )
        conn.commit()
    finally:
        conn.close()
    return {"id": pid, "name": data.name, "createdAt": now}


@app.get("/api/projects")
def list_projects(user: dict = Depends(verify_token)):
    """列出我参与的项目"""
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT p.* FROM projects p
               JOIN members m ON m.project_id = p.id
               WHERE m.user_id = ? ORDER BY p.updated_at DESC""",
            (user['userId'],),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@app.get("/api/projects/{project_id}")
def get_project(project_id: str, user: dict = Depends(verify_token)):
    """获取项目详情（含成员、片源）"""
    conn = get_db()
    try:
        proj = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if not proj:
            raise HTTPException(404, "Project not found")
        members = conn.execute("SELECT * FROM members WHERE project_id=?", (project_id,)).fetchall()
        video = conn.execute("SELECT * FROM video_sources WHERE project_id=?", (project_id,)).fetchone()
        return {
            **dict(proj),
            "members": [dict(m) for m in members],
            "videoSource": dict(video) if video else None,
        }
    finally:
        conn.close()


@app.post("/api/projects/{project_id}/members")
def add_member(
    project_id: str,
    data: ProjectMemberAdd,
    ctx: dict = Depends(require_project_role('project_id', {'owner', 'manager'})),
):
    """添加成员（仅 owner/manager 可调用）

    MVP 阶段无独立用户系统，按 username 占位 user_id；阶段3 接入用户系统后改为按 userId 查询。
    """
    if data.role not in VALID_ROLES:
        raise HTTPException(400, f"非法角色：{data.role}，可选 {','.join(sorted(VALID_ROLES))}")
    if data.role == 'owner':
        # 一个项目只允许一个 owner，禁止通过此接口添加 owner
        raise HTTPException(400, "禁止通过此接口添加 owner（每个项目仅一个 owner）")
    conn = get_db()
    try:
        # 防重复：同 userId 或同 username 已在该项目则返回提示
        if data.user_id:
            existed = conn.execute(
                "SELECT id FROM members WHERE project_id=? AND user_id=?",
                (project_id, data.user_id),
            ).fetchone()
            if existed:
                raise HTTPException(409, f"成员 {data.username} 已在该项目中")
        else:
            existed = conn.execute(
                "SELECT id FROM members WHERE project_id=? AND username=?",
                (project_id, data.username),
            ).fetchone()
            if existed:
                raise HTTPException(409, f"成员 {data.username} 已在该项目中")
        # MVP：优先用前端传入的 userId（来自 awareness 在线列表）；
        # 阶段5 用户系统上线后改为按 username 反查 users 表
        final_user_id = data.user_id or str(uuid.uuid4())
        conn.execute(
            "INSERT INTO members (id, project_id, user_id, username, role, joined_at) VALUES (?,?,?,?,?,?)",
            (str(uuid.uuid4()), project_id, final_user_id, data.username, data.role, int(time.time())),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@app.get("/api/projects/{project_id}/members")
def list_members(
    project_id: str,
    ctx: dict = Depends(require_project_role('project_id', VALID_ROLES)),
):
    """列出项目所有成员（含角色）"""
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT user_id, username, role, joined_at FROM members WHERE project_id=? ORDER BY joined_at ASC",
            (project_id,),
        ).fetchall()
        return {"members": [dict(r) for r in rows]}
    finally:
        conn.close()


@app.get("/api/projects/{project_id}/my-role")
def get_my_role(
    project_id: str,
    user: dict = Depends(verify_token),
):
    """查询当前用户在该项目中的角色（首屏拉一次缓存）"""
    role = get_member_role(project_id, user['userId'])
    if role is None:
        raise HTTPException(403, "非项目成员")
    return {"role": role, "userId": user['userId'], "username": user.get('username', '')}


@app.patch("/api/projects/{project_id}/members/{member_user_id}")
def update_member_role(
    project_id: str,
    member_user_id: str,
    data: ProjectMemberUpdate,
    ctx: dict = Depends(require_project_role('project_id', {'owner'})),
):
    """修改成员角色（仅 owner 可调用）

    禁止修改 owner 角色（owner 转让走专门的 transfer 接口，MVP 暂不实现）。
    """
    if data.role not in VALID_ROLES:
        raise HTTPException(400, f"非法角色：{data.role}")
    if data.role == 'owner':
        raise HTTPException(400, "禁止通过此接口设置为 owner（请用转让接口）")
    conn = get_db()
    try:
        # 校验目标成员存在且非 owner
        target = conn.execute(
            "SELECT role FROM members WHERE project_id=? AND user_id=?",
            (project_id, member_user_id),
        ).fetchone()
        if not target:
            raise HTTPException(404, "成员不存在")
        if target['role'] == 'owner':
            raise HTTPException(400, "禁止修改 owner 角色")
        conn.execute(
            "UPDATE members SET role=? WHERE project_id=? AND user_id=?",
            (data.role, project_id, member_user_id),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "userId": member_user_id, "role": data.role}


@app.delete("/api/projects/{project_id}/members/{member_user_id}")
def remove_member(
    project_id: str,
    member_user_id: str,
    ctx: dict = Depends(require_project_role('project_id', {'owner'})),
):
    """移除成员（仅 owner 可调用）

    禁止移除 owner（项目创建者不可被移除，需先转让 owner）。
    """
    conn = get_db()
    try:
        target = conn.execute(
            "SELECT role FROM members WHERE project_id=? AND user_id=?",
            (project_id, member_user_id),
        ).fetchone()
        if not target:
            raise HTTPException(404, "成员不存在")
        if target['role'] == 'owner':
            raise HTTPException(400, "禁止移除 owner")
        conn.execute(
            "DELETE FROM members WHERE project_id=? AND user_id=?",
            (project_id, member_user_id),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "removedUserId": member_user_id}


# ============ 协作 token 签发 ============

@app.get("/api/projects/{project_id}/collab-token")
def get_collab_token(project_id: str, user: dict = Depends(verify_token)):
    """签发连接协作服务端的 JWT token"""
    # 校验用户是否为项目成员
    conn = get_db()
    try:
        member = conn.execute(
            "SELECT * FROM members WHERE project_id=? AND user_id=?",
            (project_id, user['userId']),
        ).fetchone()
        if not member:
            raise HTTPException(403, "Not a member of this project")
    finally:
        conn.close()

    token = jwt.encode(
        {
            'userId': user['userId'],
            'username': user.get('username', ''),
            'projectId': project_id,
            'exp': int(time.time()) + 86400,
        },
        JWT_SECRET,
        algorithm='HS256',
    )
    return {"token": token, "wsUrl": COLLAB_WS_URL, "roomName": project_id}


# ============ 用户系统（阶段1：注册/登录/JWT）============

import bcrypt


class RegisterRequest(BaseModel):
    username: str
    password: str


class LoginRequest(BaseModel):
    username: str
    password: str


@app.post("/api/auth/register")
def register(data: RegisterRequest):
    """用户注册：username + password → bcrypt 存储，返回 JWT"""
    username = data.username.strip()
    if not username or not data.password:
        raise HTTPException(400, "用户名和密码不能为空")
    if len(data.password) < 6:
        raise HTTPException(400, "密码至少 6 位")
    user_id = str(uuid.uuid4())
    password_hash = bcrypt.hashpw(data.password.encode(), bcrypt.gensalt()).decode()
    conn = get_db()
    try:
        existing = conn.execute("SELECT user_id FROM users WHERE username=?", (username,)).fetchone()
        if existing:
            raise HTTPException(409, "用户名已存在")
        conn.execute(
            "INSERT INTO users (user_id, username, password_hash, created_at) VALUES (?,?,?,?)",
            (user_id, username, password_hash, int(time.time())),
        )
        conn.commit()
    finally:
        conn.close()
    token = jwt.encode(
        {'userId': user_id, 'username': username, 'exp': int(time.time()) + 86400 * 7},
        JWT_SECRET, algorithm='HS256',
    )
    return {"token": token, "userId": user_id, "username": username}


@app.post("/api/auth/login")
def login(data: LoginRequest):
    """用户登录：校验密码，返回 JWT"""
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM users WHERE username=?", (data.username.strip(),)).fetchone()
    finally:
        conn.close()
    if not row or not bcrypt.checkpw(data.password.encode(), row['password_hash'].encode()):
        raise HTTPException(401, "用户名或密码错误")
    token = jwt.encode(
        {'userId': row['user_id'], 'username': row['username'], 'exp': int(time.time()) + 86400 * 7},
        JWT_SECRET, algorithm='HS256',
    )
    return {"token": token, "userId": row['user_id'], "username": row['username']}


@app.get("/api/auth/me")
def me(user: dict = Depends(verify_token)):
    """校验当前 token，返回用户信息"""
    return {"userId": user['userId'], "username": user.get('username', '')}


# ============ 邀请码系统（阶段2）============

import secrets as _secrets


class InvitationCreateRequest(BaseModel):
    expires_in_hours: int = 72  # 默认 72 小时
    max_uses: int = 0  # 0=不限
    role: str = 'narrator'  # 被邀请者加入后的初始角色


@app.post("/api/projects/{project_id}/invitations")
def create_invitation(
    project_id: str,
    data: InvitationCreateRequest,
    ctx: dict = Depends(require_project_role('project_id', {'owner'})),
):
    """生成邀请码（仅 owner 可调用）

    使用 secrets.token_urlsafe 生成字母数字混合的唯一随机邀请码，
    存储至数据库并与当前项目ID绑定。
    """
    if data.role not in {'manager', 'reviewer', 'narrator'}:
        raise HTTPException(400, "非法角色（邀请码不可生成 owner）")
    now = int(time.time())
    expires_at = now + data.expires_in_hours * 3600
    max_uses = data.max_uses if data.max_uses and data.max_uses > 0 else 0
    conn = get_db()
    try:
        # 校验项目存在
        proj = conn.execute("SELECT id FROM projects WHERE id=?", (project_id,)).fetchone()
        if not proj:
            raise HTTPException(404, "项目不存在")
        # 生成唯一邀请码（最多重试 5 次防碰撞）
        code = None
        for _ in range(5):
            candidate = _secrets.token_urlsafe(8)  # 8 字节 = ~11 字符，字母数字混合
            existing = conn.execute(
                "SELECT code FROM invitations WHERE code=?", (candidate,)
            ).fetchone()
            if not existing:
                code = candidate
                break
        if not code:
            raise HTTPException(500, "邀请码生成失败（多次碰撞，请重试）")
        conn.execute(
            "INSERT INTO invitations (code, project_id, created_by, created_at, expires_at, max_uses, use_count, revoked, role) VALUES (?,?,?,?,?,?,?,?,?)",
            (code, project_id, ctx['user']['userId'], now, expires_at, max_uses, 0, 0, data.role),
        )
        conn.commit()
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"邀请码生成失败 project={project_id}: {type(e).__name__}: {e}")
        raise HTTPException(500, f"邀请码生成失败: {e}")
    finally:
        conn.close()
    return {
        "code": code,
        "projectId": project_id,
        "expiresAt": expires_at,
        "maxUses": max_uses,
        "role": data.role,
        "joinUrl": f"/?invite={code}",
    }


@app.get("/api/projects/{project_id}/invitations")
def list_invitations(
    project_id: str,
    ctx: dict = Depends(require_project_role('project_id', {'owner'})),
):
    """列出项目所有邀请码（仅 owner 可调用）"""
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT code, project_id, created_by, created_at, expires_at, max_uses, use_count, revoked, role FROM invitations WHERE project_id=? ORDER BY created_at DESC",
            (project_id,),
        ).fetchall()
        return {"invitations": [dict(r) for r in rows]}
    finally:
        conn.close()


@app.delete("/api/projects/{project_id}/invitations/{code}")
def revoke_invitation(
    project_id: str,
    code: str,
    ctx: dict = Depends(require_project_role('project_id', {'owner'})),
):
    """撤销邀请码（仅 owner 可调用）"""
    conn = get_db()
    try:
        cur = conn.execute(
            "UPDATE invitations SET revoked=1 WHERE code=? AND project_id=?",
            (code, project_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "邀请码不存在")
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "code": code}


@app.post("/api/invitations/{code}/join")
def join_by_invitation(code: str, user: dict = Depends(verify_token)):
    """通过邀请码加入项目

    流程：首页输入邀请码 → 后端校验有效性 → 把当前用户加入项目成员 → 返回 projectId
    """
    conn = get_db()
    try:
        inv = conn.execute("SELECT * FROM invitations WHERE code=?", (code,)).fetchone()
        if not inv:
            raise HTTPException(404, "邀请码不存在")
        if inv['revoked']:
            raise HTTPException(410, "邀请码已撤销")
        now = int(time.time())
        if inv['expires_at'] and inv['expires_at'] < now:
            raise HTTPException(410, "邀请码已过期")
        if inv['max_uses'] > 0 and inv['use_count'] >= inv['max_uses']:
            raise HTTPException(410, "邀请码使用次数已达上限")
        # 已是成员则直接返回
        existing = conn.execute(
            "SELECT id FROM members WHERE project_id=? AND user_id=?",
            (inv['project_id'], user['userId']),
        ).fetchone()
        if not existing:
            conn.execute(
                "INSERT INTO members (id, project_id, user_id, username, role, joined_at) VALUES (?,?,?,?,?,?)",
                (str(uuid.uuid4()), inv['project_id'], user['userId'], user.get('username', ''), inv['role'], now),
            )
            conn.execute(
                "UPDATE invitations SET use_count = use_count + 1 WHERE code=?",
                (code,),
            )
            conn.commit()
        proj = conn.execute("SELECT id, name FROM projects WHERE id=?", (inv['project_id'],)).fetchone()
    finally:
        conn.close()
    return {"projectId": inv['project_id'], "projectName": proj['name'] if proj else '', "role": inv['role']}


@app.get("/api/invitations/{code}/info")
def invitation_info(code: str):
    """查询邀请码信息（用于首页输入邀请码后预览项目名）"""
    conn = get_db()
    try:
        inv = conn.execute("SELECT * FROM invitations WHERE code=?", (code,)).fetchone()
        if not inv:
            raise HTTPException(404, "邀请码不存在")
        if inv['revoked']:
            raise HTTPException(410, "邀请码已撤销")
        now = int(time.time())
        if inv['expires_at'] and inv['expires_at'] < now:
            raise HTTPException(410, "邀请码已过期")
        if inv['max_uses'] > 0 and inv['use_count'] >= inv['max_uses']:
            raise HTTPException(410, "邀请码使用次数已达上限")
        proj = conn.execute("SELECT name FROM projects WHERE id=?", (inv['project_id'],)).fetchone()
        return {
            "code": code,
            "projectId": inv['project_id'],
            "projectName": proj['name'] if proj else '',
            "role": inv['role'],
            "expiresAt": inv['expires_at'],
        }
    finally:
        conn.close()


# ============ 文件转换（复用 ScriptGrid）============

@app.post("/api/convert")
async def convert_file(
    file: UploadFile = File(...),
    target_format: str = 'srt',
):
    """
    字幕文件转换（复用 ScriptGrid 解析器）
    支持 .ass/.srt/.xlsx 互转
    """
    suffix = Path(file.filename).suffix.lower()
    tmp_in = UPLOAD_DIR / f"{uuid.uuid4()}{suffix}"
    tmp_out = UPLOAD_DIR / f"{uuid.uuid4()}.{target_format}"

    try:
        with open(tmp_in, 'wb') as f:
            f.write(await file.read())

        # 解析为统一 IR
        if suffix == '.ass':
            data = parse_ass_to_srt_structure(str(tmp_in))
        elif suffix == '.srt':
            data = parse_srt(str(tmp_in))
        elif suffix == '.xlsx':
            data = parse_xlsx(str(tmp_in))
        else:
            raise HTTPException(400, f"Unsupported input format: {suffix}")

        if not data:
            raise HTTPException(400, "No data parsed from file")

        # 写出目标格式
        if target_format == 'srt':
            write_to_srt(data, str(tmp_out))
        elif target_format == 'xlsx':
            write_to_excel(data, str(tmp_out))
        elif target_format in ('vtt', 'webvtt'):
            write_to_vtt(data, str(tmp_out))
        else:
            raise HTTPException(400, f"Unsupported target format: {target_format}")

        return FileResponse(
            str(tmp_out),
            filename=f"{Path(file.filename).stem}.{target_format}",
            background=None,
        )
    finally:
        tmp_in.unlink(missing_ok=True)


def _sec_to_srt_time(sec):
    """秒(float) → SRT 时间字符串 HH:MM:SS,mmm"""
    try:
        total_ms = int(round(float(sec) * 1000))
    except (TypeError, ValueError):
        total_ms = 0
    if total_ms < 0:
        total_ms = 0
    h = total_ms // 3600000
    m = (total_ms % 3600000) // 60000
    s = (total_ms % 60000) // 1000
    ms = total_ms % 1000
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


@app.post("/api/convert/{source_format}/{target_format}")
async def convert_with_path(
    source_format: str,
    target_format: str,
    file: UploadFile = File(...),
):
    """
    路径式字幕转换：/api/convert/{source_format}/{target_format}
    source_format: ass/srt/xlsx/sup
    target_format: srt/xlsx/vtt/webvtt
    """
    src = source_format.lower()
    tgt = target_format.lower()
    supported_src = {'ass', 'srt', 'xlsx', 'sup'}
    supported_tgt = {'srt', 'xlsx', 'vtt', 'webvtt'}
    if src not in supported_src:
        raise HTTPException(400, f"Unsupported source format: {source_format}")
    if tgt not in supported_tgt:
        raise HTTPException(400, f"Unsupported target format: {target_format}")

    in_suffix = '.sup' if src == 'sup' else f'.{src}'
    tmp_in = UPLOAD_DIR / f"{uuid.uuid4()}{in_suffix}"
    out_ext = 'vtt' if tgt in ('vtt', 'webvtt') else tgt
    tmp_out = UPLOAD_DIR / f"{uuid.uuid4()}.{out_ext}"

    try:
        with open(tmp_in, 'wb') as f:
            f.write(await file.read())

        # 解析为统一 IR：[[序号, 开始, 结束, 字幕], ...]
        if src == 'ass':
            data = parse_ass_to_srt_structure(str(tmp_in))
        elif src == 'srt':
            data = parse_srt(str(tmp_in))
        elif src == 'xlsx':
            data = parse_xlsx(str(tmp_in))
        else:  # sup
            sup_result = parse_sup(str(tmp_in))
            data = [
                [str(i + 1), _sec_to_srt_time(ev['start']), _sec_to_srt_time(ev['end']), ev.get('text', '')]
                for i, ev in enumerate(sup_result.get('events', []))
            ]

        if not data:
            raise HTTPException(400, "No data parsed from file")

        if tgt == 'srt':
            write_to_srt(data, str(tmp_out))
        elif tgt == 'xlsx':
            write_to_excel(data, str(tmp_out))
        else:  # vtt / webvtt
            write_to_vtt(data, str(tmp_out))

        return FileResponse(
            str(tmp_out),
            filename=f"{Path(file.filename).stem}.{out_ext}",
            background=None,
        )
    finally:
        tmp_in.unlink(missing_ok=True)


@app.post("/api/convert/sup-ocr")
async def convert_sup_ocr(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
):
    """
    上传 SUP 文件，触发异步 OCR，返回 task_id。
    转换结果通过 GET /api/convert/task/{task_id} 查询。
    """
    if not file.filename.lower().endswith('.sup'):
        raise HTTPException(400, "File must be .sup")
    task_id = str(uuid.uuid4())
    saved = UPLOAD_DIR / f"{task_id}.sup"
    with open(saved, 'wb') as f:
        f.write(await file.read())
    return convert_subtitle_async(task_id, str(saved), 'sup-ocr', background_tasks)


@app.get("/api/convert/task/{task_id}")
def get_convert_task_status(task_id: str):
    """查询异步转换任务状态"""
    status = get_task_status(task_id)
    if status.get('status') == 'completed' and status.get('result_url'):
        return {**status, 'download_url': f"/api/convert/task/{task_id}/result"}
    return status


@app.get("/api/convert/task/{task_id}/result")
def get_convert_task_result(task_id: str):
    """下载异步任务结果文件"""
    status = get_task_status(task_id)
    if status.get('status') != 'completed' or not status.get('result_url'):
        raise HTTPException(404, "Result not ready")
    result_path = status['result_url']
    if not Path(result_path).exists():
        raise HTTPException(404, "Result file missing")
    return FileResponse(result_path, filename=f"{task_id}.json")


# ============ ASS 解析为 events（供前端导入）============

@app.post("/api/parse-ass")
async def parse_ass_file(file: UploadFile = File(...)):
    """解析 ASS 文件为前端 AssEvent 结构数组"""
    if not file.filename.lower().endswith('.ass'):
        raise HTTPException(400, "File must be .ass")
    tmp = UPLOAD_DIR / f"{uuid.uuid4()}.ass"
    try:
        with open(tmp, 'wb') as f:
            f.write(await file.read())
        events = parse_ass_to_events(str(tmp))
        return {"events": events, "count": len(events)}
    finally:
        tmp.unlink(missing_ok=True)


# ============ 片源上传 ============

@app.post("/api/projects/{project_id}/video")
async def upload_video(
    project_id: str,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    user: dict = Depends(verify_token),
):
    """上传片源（流式分块写入，支持大文件；MVP 存本地，生产换 OSS）

    上传成功后异步用 FFmpeg 提取波形 + 静音段，缓存为 JSON 文件，
    前端通过 GET /api/files/video/{project_id}/waveform 拉取。
    """
    ext = Path(file.filename).suffix
    saved = UPLOAD_DIR / f"{project_id}{ext}"
    # 流式分块写入，避免大文件撑爆内存
    with open(saved, 'wb') as f:
        while True:
            chunk = await file.read(1024 * 1024 * 4)  # 4MB 块
            if not chunk:
                break
            f.write(chunk)

    # 同步取时长（ffprobe 很快），异步提取波形+静音段（FFmpeg，耗时）
    duration = 0.0
    try:
        from ffmpeg.waveform import _ffprobe_duration
        duration = _ffprobe_duration(str(saved))
    except Exception:
        pass

    conn = get_db()
    try:
        conn.execute(
            """INSERT OR REPLACE INTO video_sources
               (project_id, oss_key, filename, duration, uploaded_by, uploaded_at)
               VALUES (?,?,?,?,?,?)""",
            (project_id, str(saved), file.filename, duration, user['userId'], int(time.time())),
        )
        conn.commit()
    finally:
        conn.close()

    # 后台异步提取波形 + 静音段（FFmpeg，可能几十秒到几分钟）
    background_tasks.add_task(_build_waveform_cache, project_id, str(saved))

    return {
        "ok": True,
        "videoUrl": f"/api/files/video/{project_id}",
        "duration": duration,
        "waveformUrl": f"/api/files/video/{project_id}/waveform",
        "waveformStatus": "processing",
    }


def _build_waveform_cache(project_id: str, video_path: str):
    """后台任务：用 FFmpeg 提取波形 + 静音段，存到 UPLOAD_DIR/<pid>.waveform.json"""
    try:
        result = extract_waveform(video_path, peaks_count=8000)
        segments = detect_silence(video_path, threshold=-30, min_duration=1.0)
        cache = {
            "peaks": result.get("peaks", []),
            "duration": result.get("duration", 0.0),
            "silenceSegments": segments,
            "builtAt": int(time.time()),
        }
        cache_path = UPLOAD_DIR / f"{project_id}.waveform.json"
        cache_path.write_text(json.dumps(cache), encoding="utf-8")
        logger.info(f"波形缓存完成: project={project_id} peaks={len(cache['peaks'])} silence={len(segments)}")
    except Exception as e:
        logger.warning(f"波形缓存构建失败 project={project_id}: {e}")


@app.get("/api/files/video/{project_id}/waveform")
def get_video_waveform(project_id: str):
    """获取视频的波形 + 静音段 JSON（由上传后后台 FFmpeg 任务生成）

    返回:
      - 已就绪: {status:"ready", peaks:[...], duration, silenceSegments:[...]}
      - 处理中: {status:"processing"}
      - 未上传: 404
    """
    cache_path = UPLOAD_DIR / f"{project_id}.waveform.json"
    if cache_path.exists():
        try:
            data = json.loads(cache_path.read_text(encoding="utf-8"))
            return {"status": "ready", **data}
        except Exception as e:
            logger.warning(f"波形缓存读取失败: {e}")
    # 缓存不存在 → 检查视频是否已上传
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM video_sources WHERE project_id=?", (project_id,)).fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(404, "Video not uploaded")
    return {"status": "processing"}


@app.get("/api/files/video/{project_id}")
def get_video(project_id: str):
    """获取片源文件"""
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM video_sources WHERE project_id=?", (project_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Video not found")
        return FileResponse(row['oss_key'], filename=row['filename'])
    finally:
        conn.close()


# ============ AI 辅助（V1.5）============

class ObjectivityCheckRequest(BaseModel):
    text: str


class ConsistencyCheckRequest(BaseModel):
    # 入参 {events: [...]}；保留 fragments 以兼容旧调用
    events: list = []
    fragments: Optional[list[str]] = None


class DurationCheckRequest(BaseModel):
    text: str
    segment_duration: float


class DurationEstimateRequest(BaseModel):
    text: str
    speed: Optional[float] = 3.5


class ContinuityCheckRequest(BaseModel):
    events: list = []


class NeutralCheckRequest(BaseModel):
    text: str


@app.post("/api/ai/objectivity")
async def ai_objectivity(data: ObjectivityCheckRequest, user: dict = Depends(verify_token)):
    """客观中性检测 + 改写推荐（旧接口）"""
    result = await check_objectivity(data.text)
    return result


@app.post("/api/ai/neutral-check")
async def ai_neutral_check(data: NeutralCheckRequest, user: dict = Depends(verify_token)):
    """客观中性检测 + 改写（新格式，detect_subjective_rewrite）"""
    return await detect_subjective_rewrite(data.text)


@app.post("/api/ai/consistency")
async def ai_consistency(data: ConsistencyCheckRequest, user: dict = Depends(verify_token)):
    """用词一致性检测，入参 {events: [...]}"""
    events = data.events
    if not events and data.fragments:
        events = [{'text': f} for f in data.fragments]
    result = await check_consistency(events)
    return result


@app.post("/api/ai/continuity")
async def ai_continuity(data: ContinuityCheckRequest, user: dict = Depends(verify_token)):
    """前后衔接检查，入参 {events: [...]}"""
    return await check_continuity(data.events)


@app.post("/api/ai/duration")
def ai_duration(data: DurationEstimateRequest, user: dict = Depends(verify_token)):
    """时长预估，入参 {text, speed?}"""
    speed = data.speed if data.speed else 3.5
    return estimate_duration(data.text, speed)


@app.post("/api/ai/duration-fit")
def ai_duration_fit(data: DurationCheckRequest, user: dict = Depends(verify_token)):
    """口述时长匹配检测"""
    return check_duration_fit(data.text, data.segment_duration)


# ============ FFmpeg 波形 + 静音检测 ============

@app.post("/api/ffmpeg/waveform")
async def ffmpeg_waveform(file: UploadFile = File(...)):
    """上传视频，返回波形 JSON（同步，本地模式）"""
    suffix = Path(file.filename).suffix or '.mp4'
    tmp = UPLOAD_DIR / f"{uuid.uuid4()}{suffix}"
    try:
        with open(tmp, 'wb') as f:
            f.write(await file.read())
        return extract_waveform(str(tmp))
    finally:
        tmp.unlink(missing_ok=True)


@app.post("/api/ffmpeg/silence")
async def ffmpeg_silence(
    file: UploadFile = File(...),
    threshold: float = -30,
    min_duration: float = 1.0,
):
    """上传视频，返回静音段 JSON（同步）"""
    suffix = Path(file.filename).suffix or '.mp4'
    tmp = UPLOAD_DIR / f"{uuid.uuid4()}{suffix}"
    try:
        with open(tmp, 'wb') as f:
            f.write(await file.read())
        segments = detect_silence(str(tmp), threshold=threshold, min_duration=min_duration)
        return {'segments': segments, 'count': len(segments)}
    finally:
        tmp.unlink(missing_ok=True)


# ============ 健康检查 ============

@app.get("/health")
def health():
    return {"status": "ok", "version": "0.1.0"}


# ============ 版本快照（元数据 API；快照本身由协作服务端生成） ============
# 注：实际快照二进制由 Node.js 协作服务端 Y.encodeStateAsUpdate 生成并存盘。
# 这里提供只读元数据查询接口，前端 VersionHistory 组件用此接口拉列表。
# MVP 阶段快照元数据存 /tmp/snapshots/<projectId>/meta.json，由协作服务端写入。

import json as _json
from pathlib import Path as _Path

SNAPSHOT_DIR = _Path("/tmp/snapshots")


@app.get("/api/projects/{project_id}/versions")
def list_versions(project_id: str):
    """列出某项目的所有版本快照"""
    meta_file = SNAPSHOT_DIR / project_id / "meta.json"
    if not meta_file.exists():
        return {"versions": []}
    try:
        versions = _json.loads(meta_file.read_text(encoding="utf-8"))
        return {"versions": versions}
    except Exception:
        return {"versions": []}


@app.get("/api/projects/{project_id}/versions/{version_id}")
def get_version(project_id: str, version_id: str):
    """获取某个版本快照的内容（二进制 Yjs update，base64 编码）"""
    import base64
    snap_file = SNAPSHOT_DIR / project_id / f"{version_id}.yjs"
    if not snap_file.exists():
        raise HTTPException(status_code=404, detail="版本不存在")
    binary = snap_file.read_bytes()
    return {
        "versionId": version_id,
        "projectId": project_id,
        "size": len(binary),
        "data": base64.b64encode(binary).decode("ascii"),
    }


@app.post("/api/projects/{project_id}/versions/{version_id}/rollback")
def rollback_version(project_id: str, version_id: str):
    """回滚到指定版本（标记请求，实际回滚由协作服务端执行）"""
    snap_file = SNAPSHOT_DIR / project_id / f"{version_id}.yjs"
    if not snap_file.exists():
        raise HTTPException(status_code=404, detail="版本不存在")
    # MVP：返回需要回滚的信号，前端再通过协作服务端 WebSocket 触发实际回滚
    return {"status": "rollback_requested", "projectId": project_id, "versionId": version_id}


# ============ 演练录音存档 ============

@app.post("/api/projects/{project_id}/rehearsal-recording")
async def upload_rehearsal_recording(project_id: str, request: Request):
    """上传演练录音文件（FormData: file 字段）"""
    form = await request.form()
    file = form.get("file")
    if not file:
        raise HTTPException(status_code=400, detail="缺少 file 字段")
    upload_dir = Path(UPLOAD_DIR) / "rehearsals" / project_id
    upload_dir.mkdir(parents=True, exist_ok=True)
    import time as _time
    filename = f"{int(_time.time())}_{file.filename}"
    file_path = upload_dir / filename
    content = await file.read()
    file_path.write_bytes(content)
    return {
        "status": "ok",
        "recordingUrl": f"/api/files/rehearsal/{project_id}/{filename}",
        "size": len(content),
    }


@app.get("/api/files/rehearsal/{project_id}/{filename}")
def get_rehearsal_recording(project_id: str, filename: str):
    """下载演练录音"""
    file_path = Path(UPLOAD_DIR) / "rehearsals" / project_id / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="录音不存在")
    return FileResponse(str(file_path))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
