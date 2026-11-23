'use strict';
// سيرفر المزرعة: Node.js + SQLite بدون أي مكتبات خارجية (يحتاج Node 22.5 أو أحدث)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const S = require('./schema');

const PORT = +process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'farm.db');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_FILE), 'backups');
const PUB = path.join(__dirname, 'public');
const SESSION_MS = 180 * 24 * 3600 * 1000; // الدخول يفضل محفوظ 180 يوم
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS farms(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, farm_id TEXT NOT NULL REFERENCES farms(id), name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE, email TEXT, pass_hash TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'يعمل',
  data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_users_farm ON users(farm_id);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, farm_id TEXT NOT NULL REFERENCES farms(id), mod TEXT NOT NULL,
  data TEXT NOT NULL, by_user TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_rec ON records(farm_id, mod);
CREATE TABLE IF NOT EXISTS perms(farm_id TEXT NOT NULL, mod TEXT NOT NULL, role TEXT NOT NULL, p TEXT NOT NULL, PRIMARY KEY(farm_id, mod, role));
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, farm_id TEXT, user_id TEXT, action TEXT, mod TEXT, rec_id TEXT, at TEXT);
`);

// ---------- أدوات ----------
class HttpErr extends Error { constructor(c, m) { super(m); this.c = c; } }
const uid = () => crypto.randomBytes(8).toString('hex');
const now = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const bad = (m) => { throw new HttpErr(400, m); };
function hashPw(pw) { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(pw, s, 64).toString('hex'); }
function checkPw(pw, st) {
  const [s, h] = String(st).split(':'); if (!s || !h) return false;
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, s, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function normPhone(p) {
  let n = String(p ?? '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/\D/g, '');
  if (n.startsWith('00')) n = n.slice(2);
  if (n.startsWith('20') && n.length === 12) n = '0' + n.slice(2);
  if (n.length < 8 || n.length > 15) bad('رقم التليفون غير صحيح');
  return n;
}
const hits = new Map();
const blocked = (k, max) => { const h = hits.get(k); return !!h && Date.now() - h.t < 900000 && h.c >= max; };
const fail = (k) => { const n = Date.now(), h = hits.get(k); if (!h || n - h.t > 900000) hits.set(k, { c: 1, t: n }); else h.c++; };
const ip = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

function loadOv(farm) {
  const o = {};
  for (const r of db.prepare('SELECT mod, role, p FROM perms WHERE farm_id=?').all(farm)) o[r.mod + '|' + r.role] = r.p;
  return o;
}
function eff(role, ov, mod) {
  if (role === S.MGR) return 'rade';
  const o = ov[mod + '|' + role];
  return o !== undefined ? o : (S.M[mod].p[role] || '');
}
const can = (me, ov, mod, p) => eff(me.role, ov, mod).includes(p);
const need = (me, ov, mod, p) => { if (!can(me, ov, mod, p)) throw new HttpErr(403, 'ليس لديك صلاحية لهذا الإجراء'); };
const audit = (me, action, mod, id) => db.prepare('INSERT INTO audit(farm_id,user_id,action,mod,rec_id,at) VALUES(?,?,?,?,?,?)').run(me.farm_id, me.id, action, mod, id || '', now());
const userOut = (u) => ({ id: u.id, name: u.name, phone: u.phone, email: u.email || '', role: u.role, status: u.status, ...JSON.parse(u.data || '{}') });

function auth(req) {
  const t = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const u = t && db.prepare(`SELECT u.*, f.name AS farm_name FROM sessions s JOIN users u ON u.id=s.user_id JOIN farms f ON f.id=u.farm_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.status!='منتهي'`).get(sha(t), Date.now());
  if (!u) throw new HttpErr(401, 'سجّل الدخول من جديد');
  return { ...u, ...JSON.parse(u.data || '{}'), farm_name: u.farm_name };
}
function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(sha(token), userId, Date.now(), Date.now() + SESSION_MS);
  return token;
}

const agents = require('./agents')({ db, uid, now, HttpErr, S });

// ---------- الحساب ----------
function register(req, b) {
  const k = 'reg:' + ip(req); if (blocked(k, 10)) throw new HttpErr(429, 'محاولات كثيرة، جرّب بعد شوية'); fail(k);
  const farm = str(b.farmName, 100), name = str(b.name, 100), phone = normPhone(b.phone), pw = String(b.password || '');
  if (!farm || !name) bad('اكتب اسم المزرعة واسمك');
  if (pw.length < 6) bad('كلمة المرور لازم 6 أحرف على الأقل');
  if (db.prepare('SELECT 1 FROM users WHERE phone=?').get(phone)) bad('رقم التليفون ده مسجل قبل كده');
  const fid = uid(), uidv = uid();
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO farms VALUES(?,?,?)').run(fid, farm, now());
    db.prepare('INSERT INTO users(id,farm_id,name,phone,email,pass_hash,role,status,data,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(uidv, fid, name, phone, str(b.email, 120).toLowerCase(), hashPw(pw), S.MGR, 'يعمل', JSON.stringify({ start: now().slice(0, 10), wage: 0 }), now());
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { token: newSession(uidv) };
}
function login(req, b) {
  const phone = normPhone(b.phone), k = 'login:' + ip(req) + ':' + phone;
  if (blocked(k, 8)) throw new HttpErr(429, 'محاولات كثيرة، استنى 15 دقيقة');
  const u = db.prepare('SELECT * FROM users WHERE phone=?').get(phone);
  if (!u || u.status === 'منتهي' || !checkPw(String(b.password || ''), u.pass_hash)) { fail(k); throw new HttpErr(401, 'رقم التليفون أو كلمة المرور غير صحيحة'); }
  hits.delete(k);
  return { token: newSession(u.id) };
}
function logout(req) {
  db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(String(req.headers.authorization || '').replace(/^Bearer /, '')));
  return { ok: true };
}

// ---------- السجلات ----------
function inScope(me, mod, d) {
  const m = S.M[mod];
  if (me.role === S.MGR) return true;
  if (m.scoped && me.role === S.WRK && d.house !== me.house) return false;
  if (m.aud && !(d.by === me.name || (S.AUDV[d.to] || []).includes(me.role))) return false;
  return true;
}
function list(me, ov, mod) {
  if (!can(me, ov, mod, 'r')) return [];
  return db.prepare('SELECT id,data FROM records WHERE farm_id=? AND mod=?').all(me.farm_id, mod)
    .map(r => ({ id: r.id, ...JSON.parse(r.data) })).filter(d => inScope(me, mod, d));
}
function listUsers(me, ov) {
  if (!can(me, ov, 'users', 'r')) return [];
  let a = db.prepare('SELECT * FROM users WHERE farm_id=? ORDER BY created_at').all(me.farm_id).map(userOut);
  if (me.role === S.ENG) a = a.filter(u => u.role === S.WRK);
  return a;
}
function options(me, f) {
  if (Array.isArray(f.o)) return me.role === S.WRK && f.wo ? f.wo : f.o;
  return f.o === '@aud' ? (S.AUD[me.role] || []) : null;
}
function clean(me, mod, b) {
  const d = {};
  for (const f of S.M[mod].f) {
    let v = b[f.k];
    if (f.t === 'number') { v = Number(v); if (!Number.isFinite(v)) v = 0; if (v < 0) bad('القيمة لا يمكن أن تكون سالبة'); }
    else if (f.t === 'date') { v = String(v || ''); if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) bad('تاريخ غير صحيح'); }
    else if (f.t === 'select') { v = str(v, 100); const o = options(me, f); if (o && !o.includes(v)) bad('اختيار غير مسموح في: ' + f.k); }
    else if (f.t === 'file') v = typeof v === 'string' && v.startsWith('data:image/') && v.length <= 700000 ? v : '';
    else { v = str(v, f.k === 'text' ? 2000 : 300); if (f.k === 'url' && v && !/^https?:\/\//.test(v)) bad('الرابط لازم يبدأ بـ http أو https'); }
    d[f.k] = v;
  }
  return d;
}
function create(me, ov, mod, b) {
  if (!S.M[mod]) throw new HttpErr(404, 'قسم غير موجود');
  if (mod === 'users') return saveUser(me, ov, b);
  need(me, ov, mod, 'a');
  const d = clean(me, mod, b);
  if (S.M[mod].scoped && me.role === S.WRK) d.house = me.house || '';
  d.by = me.name; d.at = now();
  const id = uid();
  db.prepare('INSERT INTO records(id,farm_id,mod,data,by_user,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, me.farm_id, mod, JSON.stringify(d), me.id, now(), now());
  audit(me, 'create', mod, id);
  return { id, ...d };
}
function getRec(me, mod, id) {
  const r = db.prepare('SELECT * FROM records WHERE id=? AND farm_id=? AND mod=?').get(id, me.farm_id, mod);
  if (!r) throw new HttpErr(404, 'السجل غير موجود');
  const d = JSON.parse(r.data);
  if (!inScope(me, mod, d) || (S.M[mod].aud && me.role !== S.MGR && d.by !== me.name)) throw new HttpErr(403, 'ليس لديك صلاحية على هذا السجل');
  return d;
}
function update(me, ov, mod, id, b) {
  if (!S.M[mod]) throw new HttpErr(404, 'قسم غير موجود');
  if (mod === 'users') return saveUser(me, ov, b, id);
  need(me, ov, mod, 'e');
  const old = getRec(me, mod, id), d = clean(me, mod, b);
  if (S.M[mod].scoped && me.role === S.WRK) d.house = me.house || '';
  d.by = old.by; d.at = old.at;
  db.prepare('UPDATE records SET data=?, updated_at=? WHERE id=?').run(JSON.stringify(d), now(), id);
  audit(me, 'update', mod, id);
  return { id, ...d };
}
function remove(me, ov, mod, id) {
  if (!S.M[mod]) throw new HttpErr(404, 'قسم غير موجود');
  need(me, ov, mod, 'd');
  if (mod === 'users') return deleteUser(me, id);
  getRec(me, mod, id);
  db.prepare('DELETE FROM records WHERE id=?').run(id);
  audit(me, 'delete', mod, id);
  return { ok: true };
}

// ---------- الفريق ----------
const activeManagers = (farm) => db.prepare("SELECT COUNT(*) c FROM users WHERE farm_id=? AND role=? AND status!='منتهي'").get(farm, S.MGR).c;
function saveUser(me, ov, b, id) {
  need(me, ov, 'users', id ? 'e' : 'a');
  let t = null;
  if (id) {
    t = db.prepare('SELECT * FROM users WHERE id=? AND farm_id=?').get(id, me.farm_id);
    if (!t) throw new HttpErr(404, 'المستخدم غير موجود');
    if (me.role !== S.MGR && t.role !== S.WRK) throw new HttpErr(403, 'تقدر تتعامل مع العمال بس');
  }
  const name = str(b.name, 100); if (!name) bad('الاسم مطلوب');
  const role = me.role === S.MGR ? str(b.role || S.WRK, 30) : S.WRK;
  if (!S.ROLES.includes(role)) bad('وظيفة غير صحيحة');
  const phone = b.phone || !t ? normPhone(b.phone) : t.phone;
  const dup = db.prepare('SELECT id FROM users WHERE phone=?').get(phone);
  if (dup && dup.id !== id) bad('رقم التليفون ده مسجل قبل كده');
  const status = me.role === S.MGR ? (b.status === 'منتهي' ? 'منتهي' : 'يعمل') : (t ? t.status : 'يعمل');
  if (t && t.role === S.MGR && t.status !== 'منتهي' && (role !== S.MGR || status === 'منتهي') && activeManagers(me.farm_id) <= 1) bad('لازم يفضل مدير واحد على الأقل');
  const pw = String(b.pass || '');
  if (!t && pw.length < 6) bad('كلمة المرور لازم 6 أحرف على الأقل');
  if (t && pw && pw.length < 6) bad('كلمة المرور لازم 6 أحرف على الأقل');
  const w = b.wage === undefined || b.wage === '' ? 0 : Number(b.wage); if (!Number.isFinite(w) || w < 0) bad('اليومية غير صحيحة');
  const extra = { house: str(b.house, 60), wage: w, start: str(b.start, 10), end: status === 'منتهي' ? (str(b.end, 10) || now().slice(0, 10)) : '' };
  const email = str(b.email, 120).toLowerCase();
  if (!t) {
    const nid = uid();
    db.prepare('INSERT INTO users(id,farm_id,name,phone,email,pass_hash,role,status,data,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(nid, me.farm_id, name, phone, email, hashPw(pw), role, status, JSON.stringify(extra), now());
    audit(me, 'create', 'users', nid);
    return userOut(db.prepare('SELECT * FROM users WHERE id=?').get(nid));
  }
  db.prepare('UPDATE users SET name=?, phone=?, email=?, role=?, status=?, data=?, pass_hash=? WHERE id=?')
    .run(name, phone, email, role, status, JSON.stringify(extra), pw ? hashPw(pw) : t.pass_hash, id);
  if ((status === 'منتهي' || pw) && id !== me.id) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  audit(me, 'update', 'users', id);
  return userOut(db.prepare('SELECT * FROM users WHERE id=?').get(id));
}
function deleteUser(me, id) {
  const t = db.prepare('SELECT * FROM users WHERE id=? AND farm_id=?').get(id, me.farm_id);
  if (!t) throw new HttpErr(404, 'المستخدم غير موجود');
  if (t.id === me.id) bad('مينفعش تحذف نفسك');
  if (me.role !== S.MGR && t.role !== S.WRK) throw new HttpErr(403, 'تقدر تتعامل مع العمال بس');
  if (t.role === S.MGR && t.status !== 'منتهي' && activeManagers(me.farm_id) <= 1) bad('لازم يفضل مدير واحد على الأقل');
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  audit(me, 'delete', 'users', id);
  return { ok: true };
}

// ---------- البيانات والصلاحيات ----------
function payload(me, ov) {
  const perms = { agents: agents.VIEW.includes(me.role) ? 'r' : '' }, data = {}, matrix = {};
  for (const mod of Object.keys(S.M)) {
    perms[mod] = eff(me.role, ov, mod);
    data[mod] = mod === 'users' ? listUsers(me, ov) : list(me, ov, mod);
    if (me.role === S.MGR) { matrix[mod] = {}; for (const r of S.ROLES) if (r !== S.MGR) matrix[mod][r] = eff(r, ov, mod); }
  }
  const us = db.prepare('SELECT name, data, status FROM users WHERE farm_id=?').all(me.farm_id);
  const houses = new Set(['عنبر 1', 'عنبر 2', 'عنبر 3', 'عنبر 4']);
  us.forEach(u => { const h = JSON.parse(u.data || '{}').house; if (h) houses.add(h); });
  return {
    me: { id: me.id, name: me.name, phone: me.phone, role: me.role, house: me.house || '', farm: me.farm_name },
    perms, data, matrix, houses: [...houses],
    staff: us.filter(u => u.status !== 'منتهي').map(u => u.name).sort(),
  };
}
function setPerm(me, b) {
  if (me.role !== S.MGR) throw new HttpErr(403, 'للمدير فقط');
  const mod = String(b.mod), role = String(b.role), p = String(b.p ?? '');
  if (!S.M[mod] || !S.ROLES.includes(role) || role === S.MGR || !/^[rade]*$/.test(p)) bad('بيانات غير صحيحة');
  db.prepare('INSERT OR REPLACE INTO perms(farm_id,mod,role,p) VALUES(?,?,?,?)').run(me.farm_id, mod, role, [...new Set(p)].join(''));
  audit(me, 'perm', mod, role);
  return { ok: true };
}
function backup(res, me) {
  if (me.role !== S.MGR) throw new HttpErr(403, 'للمدير فقط');
  const out = {
    exported_at: now(), farm: me.farm_name,
    users: db.prepare('SELECT * FROM users WHERE farm_id=?').all(me.farm_id).map(userOut),
    records: db.prepare('SELECT id,mod,data,created_at FROM records WHERE farm_id=?').all(me.farm_id).map(r => ({ id: r.id, mod: r.mod, ...JSON.parse(r.data) })),
    perms: db.prepare('SELECT mod,role,p FROM perms WHERE farm_id=?').all(me.farm_id),
  };
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="farm-backup.json"', ...CORS });
  res.end(JSON.stringify(out));
}

// ---------- HTTP ----------
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS' };
const send = (res, c, o) => { res.writeHead(c, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...CORS }); res.end(JSON.stringify(o)); };
function readBody(req) {
  return new Promise((ok, no) => {
    let s = '', n = 0;
    req.on('data', c => { n += c.length; if (n > 2e6) { no(new HttpErr(413, 'الطلب كبير')); req.destroy(); } else s += c; });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { no(new HttpErr(400, 'بيانات غير صحيحة')); } });
    req.on('error', no);
  });
}
async function api(req, res, m, p) {
  try {
    const b = m === 'POST' || m === 'PUT' ? await readBody(req) : {};
    let r;
    if (m === 'POST' && p === '/api/register') r = register(req, b);
    else if (m === 'POST' && p === '/api/login') r = login(req, b);
    else {
      const me = auth(req), ov = loadOv(me.farm_id);
      const rec = p.match(/^\/api\/rec\/([a-z]+)(?:\/([a-f0-9]+))?$/);
      if (m === 'POST' && p === '/api/logout') r = logout(req);
      else if (m === 'GET' && p === '/api/data') r = payload(me, ov);
      else if (m === 'GET' && p === '/api/backup') return backup(res, me);
      else if (m === 'PUT' && p === '/api/perms') r = setPerm(me, b);
      else if (rec && m === 'POST' && !rec[2]) r = create(me, ov, rec[1], b);
      else if (rec && m === 'PUT' && rec[2]) r = update(me, ov, rec[1], rec[2], b);
      else if (rec && m === 'DELETE' && rec[2]) r = remove(me, ov, rec[1], rec[2]);
      else r = await agents.route(me, m, p, b);
    }
    if (r === undefined) throw new HttpErr(404, 'غير موجود');
    send(res, 200, r);
  } catch (e) {
    if (e instanceof HttpErr) send(res, e.c, { error: e.message });
    else { console.error(e); send(res, 500, { error: 'خطأ في السيرفر' }); }
  }
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
function serveStatic(req, res, p) {
  let f = path.join(PUB, decodeURIComponent(p));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(PUB, 'index.html');
  if (!fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('السيرفر شغال. ابني الفرونت وانسخه في server/public (انظر README).'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(f).pipe(res);
}
const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (p.startsWith('/api/')) return api(req, res, req.method, p);
  serveStatic(req, res, p);
});

// ---------- نسخ احتياطي تلقائي + تنظيف ----------
function maintenance() {
  try {
    db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const f = path.join(BACKUP_DIR, 'farm-' + now().slice(0, 10) + '.db');
    if (!fs.existsSync(f)) db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`);
    fs.readdirSync(BACKUP_DIR).filter(x => x.endsWith('.db')).sort().slice(0, -14).forEach(x => fs.unlinkSync(path.join(BACKUP_DIR, x)));
  } catch (e) { console.error('maintenance:', e.message); }
}
maintenance();
setInterval(maintenance, 6 * 3600 * 1000).unref();
if (require.main === module) {
  if (process.env.AGENTS_AUTORUN !== '0') agents.start();
  server.listen(PORT, () => console.log('Farm server: http://localhost:' + PORT + '  (DB: ' + DB_FILE + ')'));
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { server.close(); db.close(); process.exit(0); });
}
server.agents = agents;
module.exports = server;
