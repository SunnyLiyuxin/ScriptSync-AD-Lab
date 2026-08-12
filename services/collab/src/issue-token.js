/**
 * JWT 签发工具
 * 供 Python API 层调用，为前端换取连接协作服务端的 token
 * MVP 阶段：作为独立工具脚本，由 API 层通过环境变量共享 JWT_SECRET 签发
 */
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'scriptsync-dev-secret-change-in-prod';
const TOKEN_TTL = process.env.TOKEN_TTL || '24h';

/**
 * 签发协作 token
 * @param {string} userId - 用户ID
 * @param {string} username - 用户名
 * @param {string} projectId - 项目ID（房间名）
 * @returns {string} JWT token
 */
export function issueCollabToken(userId, username, projectId) {
  return jwt.sign(
    { userId, username, projectId },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL },
  );
}

// 命令行调用入口（供测试用）
if (import.meta.url === `file://${process.argv[1]}`) {
  const [userId, username, projectId] = process.argv.slice(2);
  if (!userId || !username || !projectId) {
    console.error('Usage: node issue-token.js <userId> <username> <projectId>');
    process.exit(1);
  }
  console.log(issueCollabToken(userId, username, projectId));
}
