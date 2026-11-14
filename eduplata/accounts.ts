/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * EduPlata - Cuentas de usuario, datos por usuario y link personal del conector de Claude.
 *
 * - Registro / inicio de sesión con Supabase Auth (correo + contraseña). Las llamadas a Supabase
 *   se hacen desde este servidor; el navegador solo recibe una cookie httpOnly con la sesión.
 * - Cada usuario tiene su fila en `eduplata_user_state` (datos JSON + versión).
 * - Cada usuario puede generar su link personal del conector MCP. Solo se guarda el hash SHA-256
 *   de la clave; el conector (eduplata/mcp_server) busca al usuario por ese hash.
 *
 * Sin Supabase configurado (desarrollo local) hay un único usuario "local" y los datos van a
 * data/eduplata_database.json.
 */

import type { Express, NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const TABLE = 'eduplata_user_state';
const COOKIE = 'edu_session';
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 días
const DEFAULT_MCP_URL = 'https://eduplata.fastmcp.app/mcp';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

type Session = { access_token: string; refresh_token: string; expires_at: number };

const clean = (v: string) => v.trim().replace(/^['"]|['"]$/g, '').trim();

export function supabaseConfig() {
  const rawUrl = clean(process.env.SUPABASE_URL || '');
  const url = rawUrl
    ? (/^https?:\/\//.test(rawUrl) ? rawUrl : `https://${rawUrl}`).replace(/\/+$/, '').replace(/\/rest\/v1$/, '')
    : '';
  const key = clean(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  return { url, key, enabled: Boolean(url && key) };
}

export function registerAccountRoutes(app: Express, dataDir: string) {
  const sb = supabaseConfig();
  const LOCAL_USER: SessionUser = { id: 'local', email: 'local@eduplata.dev', name: 'Estudiante' };
  const LOCAL_FILE = path.join(dataDir, 'eduplata_database.json');
  const isProd = process.env.NODE_ENV === 'production';

  if (!sb.enabled && !fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  console.log(`[EduPlata] Cuentas: ${sb.enabled ? 'Supabase Auth' : 'modo local (un solo usuario, sin login)'}`);

  // ───────────── Helpers Supabase ─────────────
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    apikey: sb.key,
    ...(sb.key.startsWith('eyJ') ? { Authorization: `Bearer ${sb.key}` } : {}),
    'Content-Type': 'application/json',
    ...extra
  });

  async function sbFetch(pathAndQuery: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
    const r = await fetch(`${sb.url}${pathAndQuery}`, { ...init, headers: headers(init.headers || {}) });
    const text = await r.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { ok: r.ok, status: r.status, body };
  }

  // ───────────── Cookies de sesión ─────────────
  function readSession(req: Request): Session | null {
    const raw = (req.headers.cookie || '')
      .split(';')
      .map(c => c.trim())
      .find(c => c.startsWith(`${COOKIE}=`));
    if (!raw) return null;
    try {
      return JSON.parse(Buffer.from(decodeURIComponent(raw.slice(COOKIE.length + 1)), 'base64url').toString('utf-8'));
    } catch {
      return null;
    }
  }

  function writeSession(res: Response, s: Session | null) {
    const base = `${COOKIE}=${s ? Buffer.from(JSON.stringify(s)).toString('base64url') : ''}; Path=/; HttpOnly; SameSite=Lax${isProd ? '; Secure' : ''}`;
    res.append('Set-Cookie', s ? `${base}; Max-Age=${COOKIE_MAX_AGE_S}` : `${base}; Max-Age=0`);
  }

  const toSession = (b: any): Session => ({
    access_token: b.access_token,
    refresh_token: b.refresh_token,
    expires_at: Number(b.expires_at) || Math.floor(Date.now() / 1000) + Number(b.expires_in || 3600)
  });

  const toUser = (u: any): SessionUser => ({
    id: u.id,
    email: u.email,
    name: u.user_metadata?.name || u.email?.split('@')[0] || ''
  });

  // Caché corta para no consultar Supabase en cada petición (la app sincroniza cada 15 s)
  const verified = new Map<string, { user: SessionUser; until: number }>();

  async function resolveUser(req: Request, res: Response): Promise<SessionUser | null> {
    if (!sb.enabled) return LOCAL_USER;
    let s = readSession(req);
    if (!s?.access_token) return null;

    // Renovar el token si vence en menos de 60 s
    if (s.expires_at - 60 < Date.now() / 1000) {
      const r = await sbFetch('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: s.refresh_token })
      });
      if (!r.ok) {
        writeSession(res, null);
        return null;
      }
      s = toSession(r.body);
      writeSession(res, s);
    }

    const cached = verified.get(s.access_token);
    if (cached && cached.until > Date.now()) return cached.user;

    const r = await sbFetch('/auth/v1/user', { headers: { Authorization: `Bearer ${s.access_token}` } });
    if (!r.ok) {
      writeSession(res, null);
      return null;
    }
    const user = toUser(r.body);
    verified.set(s.access_token, { user, until: Date.now() + 5 * 60 * 1000 });
    if (verified.size > 5000) verified.clear();
    return user;
  }

  // Middleware: exige sesión iniciada; deja el usuario en res.locals.user
  async function requireUser(req: Request, res: Response, next: NextFunction) {
    try {
      const user = await resolveUser(req, res);
      if (!user) return res.status(401).json({ success: false, error: 'Inicia sesión para continuar.' });
      res.locals.user = user;
      return next();
    } catch (err) {
      console.error('[EduPlata Auth] Error verificando sesión:', err);
      return res.status(503).json({ success: false, error: 'No se pudo verificar la sesión. Intenta de nuevo.' });
    }
  }

  // ───────────── Datos por usuario (versión optimista) ─────────────
  type Stored = { data: any; version: number };

  function readLocalFile(): Record<string, Stored> {
    if (!fs.existsSync(LOCAL_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf-8'));
    // Formato anterior (un solo usuario, sin "users")
    if (parsed && !parsed.users) return { local: { data: parsed.data ?? null, version: parsed.version ?? 0 } };
    return parsed.users;
  }

  async function readState(userId: string): Promise<Stored> {
    if (!sb.enabled) return readLocalFile()[userId] || { data: null, version: 0 };
    const r = await sbFetch(`/rest/v1/${TABLE}?user_id=eq.${encodeURIComponent(userId)}&select=data,version`);
    if (!r.ok) throw new Error(`Supabase GET ${r.status}: ${JSON.stringify(r.body)}`);
    if (!r.body.length) return { data: null, version: 0 };
    const d = r.body[0].data;
    return { data: d && Object.keys(d).length ? d : null, version: Number(r.body[0].version) };
  }

  /** Inserta la fila del usuario si no existe (sin tocar una existente). */
  async function ensureRow(userId: string) {
    const r = await sbFetch(`/rest/v1/${TABLE}?on_conflict=user_id`, {
      method: 'POST',
      headers: { Prefer: 'return=minimal,resolution=ignore-duplicates' },
      body: JSON.stringify({ user_id: userId, data: {}, version: 0 })
    });
    if (!r.ok) throw new Error(`Supabase POST ${r.status}: ${JSON.stringify(r.body)}`);
  }

  async function writeState(userId: string, data: any, baseVersion: number): Promise<number | null> {
    const next = baseVersion + 1;
    if (!sb.enabled) {
      const all = readLocalFile();
      if ((all[userId]?.version ?? 0) !== baseVersion) return null;
      all[userId] = { data, version: next };
      fs.writeFileSync(LOCAL_FILE, JSON.stringify({ users: all }, null, 2), 'utf-8');
      return next;
    }
    if (baseVersion === 0) await ensureRow(userId);
    const r = await sbFetch(`/rest/v1/${TABLE}?user_id=eq.${encodeURIComponent(userId)}&version=eq.${baseVersion}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ data, version: next, updated_at: new Date().toISOString() })
    });
    if (!r.ok) throw new Error(`Supabase PATCH ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body.length === 1 ? next : null;
  }

  // ───────────── Rutas de autenticación ─────────────
  const authError = (r: { status: number; body: any }) => {
    const msg = String(r.body?.msg || r.body?.message || r.body?.error_description || r.body?.error || '').toLowerCase();
    if (msg.includes('already') || msg.includes('registered') || msg.includes('exists')) return 'Ya existe una cuenta con ese correo. Inicia sesión.';
    if (msg.includes('invalid login') || msg.includes('invalid_grant') || msg.includes('invalid credentials')) return 'Correo o contraseña incorrectos.';
    if (msg.includes('password')) return 'La contraseña debe tener al menos 6 caracteres.';
    if (msg.includes('email')) return 'Revisa el correo: no parece válido.';
    if (r.status === 429) return 'Demasiados intentos. Espera un momento e intenta de nuevo.';
    return 'No se pudo completar. Intenta de nuevo.';
  };

  async function signIn(email: string, password: string) {
    return sbFetch('/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email, password }) });
  }

  app.get('/api/auth/me', async (req, res) => {
    try {
      const user = await resolveUser(req, res);
      return res.json({ success: true, user, localMode: !sb.enabled });
    } catch {
      return res.status(503).json({ success: false, error: 'No se pudo verificar la sesión.' });
    }
  });

  app.post('/api/auth/signup', async (req, res) => {
    if (!sb.enabled) return res.json({ success: true, user: LOCAL_USER });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const name = String(req.body?.name || '').trim().slice(0, 80);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ success: false, error: 'Escribe un correo válido.' });
    if (password.length < 6) return res.status(400).json({ success: false, error: 'La contraseña debe tener al menos 6 caracteres.' });
    try {
      // Se crea la cuenta ya confirmada (no depende del envío de correos de Supabase)
      const created = await sbFetch('/auth/v1/admin/users', {
        method: 'POST',
        body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { name } })
      });
      if (!created.ok) return res.status(400).json({ success: false, error: authError(created) });
      const r = await signIn(email, password);
      if (!r.ok) return res.status(400).json({ success: false, error: authError(r) });
      writeSession(res, toSession(r.body));
      return res.json({ success: true, user: toUser(r.body.user) });
    } catch (err) {
      console.error('[EduPlata Auth] Error en registro:', err);
      return res.status(503).json({ success: false, error: 'No se pudo crear la cuenta. Intenta de nuevo.' });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    if (!sb.enabled) return res.json({ success: true, user: LOCAL_USER });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    try {
      const r = await signIn(email, password);
      if (!r.ok) return res.status(401).json({ success: false, error: authError(r) });
      writeSession(res, toSession(r.body));
      return res.json({ success: true, user: toUser(r.body.user) });
    } catch (err) {
      console.error('[EduPlata Auth] Error en login:', err);
      return res.status(503).json({ success: false, error: 'No se pudo iniciar sesión. Intenta de nuevo.' });
    }
  });

  app.post('/api/auth/logout', async (req, res) => {
    const s = readSession(req);
    if (sb.enabled && s?.access_token) {
      verified.delete(s.access_token);
      await sbFetch('/auth/v1/logout', { method: 'POST', headers: { Authorization: `Bearer ${s.access_token}` } }).catch(() => {});
    }
    writeSession(res, null);
    return res.json({ success: true });
  });

  // ───────────── Datos del usuario ─────────────
  app.get('/api/database', requireUser, async (req, res) => {
    try {
      const { data, version } = await readState(res.locals.user.id);
      return res.json({ success: true, data, version });
    } catch (err) {
      console.error('[EduPlata DB] Error leyendo:', err);
      return res.status(500).json({ success: false, error: 'Error leyendo tus datos.' });
    }
  });

  app.post('/api/database', requireUser, async (req, res) => {
    const { data, baseVersion } = req.body || {};
    if (!data || typeof data !== 'object' || typeof baseVersion !== 'number') {
      return res.status(400).json({ success: false, error: 'Se requiere { data, baseVersion }.' });
    }
    try {
      const userId = res.locals.user.id;
      const version = await writeState(userId, data, baseVersion);
      if (version === null) {
        const current = await readState(userId);
        return res.status(409).json({ success: false, conflict: true, data: current.data, version: current.version });
      }
      return res.json({ success: true, version });
    } catch (err) {
      console.error('[EduPlata DB] Error guardando:', err);
      return res.status(500).json({ success: false, error: 'Error guardando tus datos.' });
    }
  });

  // ───────────── Link personal del conector de Claude ─────────────
  const mcpUrl = () => clean(process.env.MCP_PUBLIC_URL || '') || DEFAULT_MCP_URL;

  app.get('/api/connector', requireUser, async (req, res) => {
    if (!sb.enabled) return res.json({ success: true, hasKey: false, mcpUrl: mcpUrl(), localMode: true });
    try {
      const r = await sbFetch(`/rest/v1/${TABLE}?user_id=eq.${res.locals.user.id}&select=connector_key_created_at`);
      if (!r.ok) throw new Error(`Supabase GET ${r.status}`);
      const createdAt = r.body[0]?.connector_key_created_at || null;
      return res.json({ success: true, hasKey: Boolean(createdAt), createdAt, mcpUrl: mcpUrl() });
    } catch (err) {
      console.error('[EduPlata Conector] Error:', err);
      return res.status(500).json({ success: false, error: 'No se pudo consultar el conector.' });
    }
  });

  // Genera (o regenera) la clave personal. La anterior deja de funcionar.
  app.post('/api/connector', requireUser, async (req, res) => {
    if (!sb.enabled) return res.status(400).json({ success: false, error: 'El conector personal requiere Supabase.' });
    try {
      const userId = res.locals.user.id;
      const key = `edu_${crypto.randomBytes(24).toString('base64url')}`;
      const hash = crypto.createHash('sha256').update(key).digest('hex');
      await ensureRow(userId);
      const createdAt = new Date().toISOString();
      const r = await sbFetch(`/rest/v1/${TABLE}?user_id=eq.${userId}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ connector_key_hash: hash, connector_key_created_at: createdAt })
      });
      if (!r.ok) throw new Error(`Supabase PATCH ${r.status}: ${JSON.stringify(r.body)}`);
      return res.json({ success: true, url: `${mcpUrl()}?key=${key}`, createdAt });
    } catch (err) {
      console.error('[EduPlata Conector] Error generando clave:', err);
      return res.status(500).json({ success: false, error: 'No se pudo generar el link.' });
    }
  });

  // Diagnóstico para /api/health (sin datos de usuarios)
  async function healthCheck(): Promise<string> {
    if (!sb.enabled) return 'ok';
    try {
      const r = await sbFetch(`/rest/v1/${TABLE}?select=user_id&limit=1`);
      if (!r.ok) return `error HTTP ${r.status} de Supabase`;
      return 'ok';
    } catch (err: any) {
      return `error de conexión: ${err?.cause?.code || String(err?.message || err).slice(0, 80)}`;
    }
  }

  return { requireUser, healthCheck, supabaseEnabled: sb.enabled, supabaseHost: sb.enabled ? new URL(sb.url).host : null };
}
