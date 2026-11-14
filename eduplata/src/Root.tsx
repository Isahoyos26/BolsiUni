/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * EduPlata - Raíz: verifica la sesión y muestra el login o la app del usuario.
 */

import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import App from './App';
import { AuthScreen } from './components/AuthScreen';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

const LAST_USER_KEY = 'bolsiuni_last_user_id';
// Datos cacheados en el navegador: se borran al cambiar de cuenta para no mezclar usuarios
const USER_DATA_KEYS = [
  'bolsiuni_v2_transactions',
  'bolsiuni_v2_budget',
  'bolsiuni_v2_goals',
  'bolsiuni_v2_profile',
  'bolsiuni_v2_ai_analysis',
  'bolsiuni_v2_semester',
  'bolsiuni_v2_scheduled_payments',
  'eduplata_claude_quick_chat_history_v1',
  'bolsiuni_gemini_api_key'
];

function clearCachedUserData() {
  try {
    USER_DATA_KEYS.forEach(k => localStorage.removeItem(k));
    Object.keys(localStorage)
      .filter(k => k.toLowerCase().includes('chat'))
      .forEach(k => localStorage.removeItem(k));
  } catch {
    /* almacenamiento no disponible */
  }
}

function prepareCacheFor(user: AuthUser) {
  try {
    if (localStorage.getItem(LAST_USER_KEY) !== user.id) {
      clearCachedUserData();
      localStorage.setItem(LAST_USER_KEY, user.id);
    }
  } catch {
    /* almacenamiento no disponible */
  }
}

export default function Root() {
  const [state, setState] = useState<{ status: 'loading' | 'anon' | 'error' } | { status: 'user'; user: AuthUser }>({
    status: 'loading'
  });

  // Tema oscuro también en la pantalla de login
  useEffect(() => {
    try {
      if (JSON.parse(localStorage.getItem('bolsiuni_dark_mode') || 'false')) {
        document.documentElement.classList.add('dark');
      }
    } catch {
      /* sin preferencia guardada */
    }
  }, []);

  const checkSession = () => {
    setState({ status: 'loading' });
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(res => {
        if (res.success && res.user) {
          prepareCacheFor(res.user);
          setState({ status: 'user', user: res.user });
        } else {
          setState({ status: 'anon' });
        }
      })
      .catch(() => setState({ status: 'error' }));
  };

  useEffect(checkSession, []);

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    clearCachedUserData();
    window.location.reload();
  };

  if (state.status === 'loading' || state.status === 'error') {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col items-center justify-center gap-3 px-4 text-center">
        {state.status === 'loading' ? (
          <>
            <Loader2 className="w-6 h-6 text-emerald-600 animate-spin" />
            <p className="text-sm text-slate-500 dark:text-slate-400">Cargando EduPlata…</p>
          </>
        ) : (
          <>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              No se pudo conectar con el servidor. Si la app estaba dormida, tarda alrededor de un minuto en despertar.
            </p>
            <button onClick={checkSession} className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-semibold">
              Reintentar
            </button>
          </>
        )}
      </div>
    );
  }

  if (state.status === 'anon') {
    return (
      <AuthScreen
        onAuthenticated={user => {
          prepareCacheFor(user);
          setState({ status: 'user', user });
        }}
      />
    );
  }

  if (state.status !== 'user') return null;
  return <App key={state.user.id} user={state.user} onLogout={handleLogout} />;
}
