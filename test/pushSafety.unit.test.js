// Auditoría de seguridad (2026-11-28): el texto del push que escribe el organizador sale sin enlaces.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/mongo.js', () => ({ getDb: () => ({}) }));

const { plain } = await import('../src/messaging/handlers.js');

describe('plain (texto del push)', () => {
  it.each([
    ['Reclama tu boleta en https://evil.co/x ya', 'Reclama tu boleta en ya'],
    ['Gana en festa-premios.com hoy', 'Gana en hoy'],
    ['visita www.algo.org', 'visita'],
    ['entra a pagos.festa.xn--p1ai/boleta', 'entra a'],
  ])('quita enlaces y dominios: %s', (input, expected) => {
    expect(plain(input)).toBe(expected);
  });

  it('quita saltos de línea y caracteres de control o de dirección (RLO)', () => {
    expect(plain('Café‮ La Escuela\nnoche\u0007')).toBe('Café La Escuela noche');
  });

  it('conserva el texto normal: horas, nombres y acentos', () => {
    expect(plain('Jazz 19.30 en el Bloque G · Ñandú')).toBe('Jazz 19.30 en el Bloque G · Ñandú');
  });

  it('recorta al largo máximo', () => {
    const out = plain('a'.repeat(200), 80);
    expect(out).toHaveLength(80);
    expect(out.endsWith('…')).toBe(true);
  });
});
