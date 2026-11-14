/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * EduPlata - Cuenta del usuario y link personal del conector de Claude.
 */

import React, { useEffect, useState } from 'react';
import { Bot, Check, Copy, KeyRound, Loader2, LogOut, RefreshCw, UserCircle2 } from 'lucide-react';
import type { AuthUser } from '../Root';

interface ConnectClaudeCardProps {
  user: AuthUser;
  onLogout: () => void;
}

export const ConnectClaudeCard: React.FC<ConnectClaudeCardProps> = ({ user, onLogout }) => {
  const [info, setInfo] = useState<{ hasKey: boolean; createdAt?: string; localMode?: boolean } | null>(null);
  const [link, setLink] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/connector')
      .then(r => r.json())
      .then(res => res.success && setInfo(res))
      .catch(() => {});
  }, []);

  const generate = async () => {
    if (info?.hasKey && !link && !confirm('Se creará un link nuevo y el anterior dejará de funcionar en Claude. ¿Continuar?')) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/connector', { method: 'POST' }).then(r => r.json());
      if (!res.success) throw new Error(res.error);
      setLink(res.url);
      setInfo({ hasKey: true, createdAt: res.createdAt });
      setCopied(false);
    } catch (e: any) {
      setError(e?.message || 'No se pudo generar el link.');
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* el usuario puede copiarlo a mano */
    }
  };

  return (
    <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200/80 dark:border-slate-800 shadow-sm p-6 space-y-5">
      {/* Cuenta */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-11 h-11 rounded-2xl bg-emerald-100 dark:bg-emerald-950/80 flex items-center justify-center text-emerald-700 dark:text-emerald-300 shrink-0">
            <UserCircle2 className="w-6 h-6" />
          </div>
          <div className="min-w-0">
            <p className="font-bold text-slate-900 dark:text-white truncate">{user.name || 'Mi cuenta'}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{user.email}</p>
          </div>
        </div>
        <button
          onClick={onLogout}
          className="inline-flex items-center gap-1.5 text-sm font-semibold px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700"
        >
          <LogOut className="w-4 h-4" /> Cerrar sesión
        </button>
      </div>

      <hr className="border-slate-200 dark:border-slate-800" />

      {/* Conector de Claude */}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-tr from-orange-400 to-amber-500 flex items-center justify-center text-white shadow-md shadow-orange-500/20 shrink-0">
            <Bot className="w-6 h-6" />
          </div>
          <div>
            <h3 className="font-bold text-slate-900 dark:text-white">Conectar con Claude</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Cuéntale a Claude tus gastos ("me gasté 15 lucas en almuerzo") y aparecen aquí solos.
            </p>
          </div>
        </div>

        {info?.localMode ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">Disponible cuando la app está publicada con Supabase.</p>
        ) : link ? (
          <div className="space-y-3">
            <div className="flex gap-2">
              <input
                readOnly
                value={link}
                onFocus={e => e.currentTarget.select()}
                className="flex-1 min-w-0 px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs font-mono text-slate-700 dark:text-slate-200"
              />
              <button
                onClick={copy}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold shrink-0"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied ? 'Copiado' : 'Copiar'}
              </button>
            </div>
            <p className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60 rounded-xl px-3 py-2">
              🔒 Este link es como una contraseña: quien lo tenga puede registrar movimientos en tu cuenta. No lo compartas.
              Por seguridad solo se muestra ahora; si lo pierdes, genera uno nuevo.
            </p>
            <ol className="text-sm text-slate-600 dark:text-slate-300 list-decimal pl-5 space-y-1">
              <li>
                En <b>claude.ai</b> ve a <b>Configuración → Conectores → Añadir → Conector personalizado</b>.
              </li>
              <li>
                Nombre: <b>EduPlata</b>. URL: pega este link. Deja la configuración avanzada vacía.
              </li>
              <li>En un chat nuevo activa EduPlata y prueba: “¿Cuál es mi saldo en bolsillo?”</li>
            </ol>
          </div>
        ) : (
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={generate}
              disabled={loading || !info}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white text-sm font-bold shadow-md shadow-emerald-600/20"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : info?.hasKey ? <RefreshCw className="w-4 h-4" /> : <KeyRound className="w-4 h-4" />}
              {info?.hasKey ? 'Generar un link nuevo' : 'Generar mi link de Claude'}
            </button>
            {info?.hasKey && info.createdAt && (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Ya tienes un link activo desde el {new Date(info.createdAt).toLocaleDateString('es-CO')}.
              </span>
            )}
          </div>
        )}
        {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
      </div>
    </div>
  );
};
