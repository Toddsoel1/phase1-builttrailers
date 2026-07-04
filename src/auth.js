// Authentication & authorization — bcrypt password hashing + JWT sessions + role guards.
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { one, all } from './db.js';

export const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const TIER_RANK = { viewer: 0, editor: 1, admin: 2 };

export function hashPassword(pw) { return bcrypt.hashSync(pw, 10); }
export function checkPassword(pw, hash) { return bcrypt.compareSync(pw, hash); }
export function signToken(user) {
  // 7 days by default: staff live in this app on their phones now (sessions also persist in
  // localStorage), so a 12h expiry meant re-typing a password mid-week — an adoption killer.
  return jwt.sign({ id: user.id, username: user.username, role: user.role, title: user.title }, JWT_SECRET,
    { expiresIn: process.env.STAFF_SESSION || '7d' });
}

export async function authMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(tok, JWT_SECRET);
    if (payload.kind === 'dealer') return res.status(403).json({ error: 'Staff access required' });
    const u = await one('SELECT id,name,username,title,role,manager_id,email,workstation FROM app_user WHERE id=$1', [payload.id]);
    if (!u) return res.status(401).json({ error: 'User not found' });
    // All job titles the user holds (multi-role), resolved live so changes need no re-login.
    const titleRows = await all('SELECT role_name FROM user_title WHERE user_id=$1', [u.id]);
    u.titles = titleRows.length ? titleRows.map(r => r.role_name) : (u.title ? [u.title] : []);
    // Live section permissions = union across all the user's job titles (admins see all).
    // Resolved per request so title changes take effect without re-login.
    if (u.role === 'admin') {
      u.sections = null;
    } else {
      const rows = await all('SELECT DISTINCT rs.section FROM user_title ut JOIN role_section rs ON rs.role_name=ut.role_name WHERE ut.user_id=$1', [u.id]);
      u.sections = rows.map(r => r.section);
    }
    req.user = u;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// True if the user holds ANY of the given job titles (across all their assigned titles).
export function userHasTitle(user, names) {
  if (!user) return false;
  const own = (user.titles && user.titles.length) ? user.titles : (user.title ? [user.title] : []);
  return own.some(t => names.includes(t));
}

export function requireTier(minTier) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if ((TIER_RANK[req.user.role] ?? -1) < TIER_RANK[minTier])
      return res.status(403).json({ error: `Requires ${minTier} access` });
    next();
  };
}
