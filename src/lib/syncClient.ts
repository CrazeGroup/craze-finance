import { SYNC_COMPANIES, SYNC_STEPS } from './syncSteps';

// Sincroniza con BC desde el navegador paso a paso (empresa × paso), como Configuración → Sincronizar.
// company 'ALL' o vacío = todas las empresas. Devuelve los errores de los pasos que fallen (sigue con el resto).
export async function syncFromBc(company: string | undefined, onProgress?: (message: string) => void): Promise<string[]> {
  const companies = !company || company === 'ALL' ? SYNC_COMPANIES : [company];
  const errors: string[] = [];
  for (const comp of companies) {
    for (const step of SYNC_STEPS) {
      onProgress?.(`Sincronizando ${comp} · ${step.label}…`);
      try {
        const res = await fetch('/api/sync-bc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ company: comp, step: step.key }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) errors.push(`${comp} · ${step.label}: ${data.error || `HTTP ${res.status}`}`);
      } catch (e: any) {
        errors.push(`${comp} · ${step.label}: ${e.message}`);
      }
    }
  }
  return errors;
}
