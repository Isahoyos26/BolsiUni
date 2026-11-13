/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Fusión a 3 vías del estado de la app.
 * Se usa cuando la app web y el conector MCP de Claude escriben a la vez:
 *  - base:   último estado que la app sabe que estaba guardado en el servidor
 *  - local:  estado actual en el navegador (con cambios aún no guardados)
 *  - remote: estado que está ahora en el servidor (con cambios de Claude u otro navegador)
 * Los cambios locales (altas, ediciones, borrados por id) se aplican sobre el remoto.
 */

export interface AppState {
  companyProfile: any;
  partners: any[];
  properties: any[];
  transactions: any[];
  scheduledPayments: any[];
  budget: any;
}

const LIST_KEYS = ['partners', 'properties', 'transactions', 'scheduledPayments'] as const;
const OBJECT_KEYS = ['companyProfile', 'budget'] as const;

// Serialización estable (Postgres jsonb no conserva el orden de las llaves)
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter(k => obj[k] !== undefined)
      .sort()
      .map(k => `${JSON.stringify(k)}:${stable(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const same = (a: unknown, b: unknown) => stable(a) === stable(b);

function mergeList(base: any[] = [], local: any[] = [], remote: any[] = []): any[] {
  const baseById = new Map(base.map(x => [x.id, x]));
  const localById = new Map(local.map(x => [x.id, x]));
  const result = new Map(remote.map(x => [x.id, x]));

  // Borrados locales
  for (const id of baseById.keys()) {
    if (!localById.has(id)) result.delete(id);
  }
  // Altas y ediciones locales
  const localAdds: any[] = [];
  for (const item of local) {
    const before = baseById.get(item.id);
    if (!before) {
      if (!result.has(item.id)) localAdds.push(item);
      else result.set(item.id, item);
    } else if (!same(before, item)) {
      result.set(item.id, item);
    }
  }
  return [...localAdds, ...result.values()];
}

export function mergeStates(base: AppState, local: AppState, remote: AppState): AppState {
  const merged: any = { ...remote };
  for (const key of LIST_KEYS) {
    merged[key] = mergeList(base[key], local[key], remote[key]);
  }
  for (const key of OBJECT_KEYS) {
    merged[key] = same(base[key], local[key]) ? remote[key] : local[key];
  }
  return merged as AppState;
}

export const statesEqual = same;
