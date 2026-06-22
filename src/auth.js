// Authentication & authorization — bcrypt password hashing + JWT sessions + role guards.
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { one } from './db.js';

export const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const TIER_RANK = { viewer: 0, editor: 1, admin: 2 };

export function hashPassword(pw) { return bcrypt.hashSync(pw, 10); }
export function checkPassword(pw, hash) { return bcrypt.compareSync(pw, hash); }
export function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role, title: user.title }, JWT_SECRET, { expiresIn: '12h' });
}

export async function authMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(tok, JWT_SECRET);
    if (payload.kind === 'dealer') return res.status(403).json({ error: 'Staff access required' });
    const u = await one('SELECT id,name,username,title,role,manager_id FROM app_user WHERE id=$1', [payload.id]);
    if (!u) return res.status(401).json({ error: 'User not found' });
    req.user = u;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

export function requireTier(minTier) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if ((TIER_RANK[req.user.role] ?? -1) < TIER_RANK[minTier])
      return res.status(403).json({ error: `Requires ${minTier} access` });
    next();
  };
}
