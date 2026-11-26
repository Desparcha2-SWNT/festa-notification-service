// Avisos de eventos cercanos: solo a quien tiene la categoría entre sus intereses.
import { describe, expect, it, vi } from 'vitest';

const n = vi.hoisted(() => ({ notifyUsers: vi.fn() }));
vi.mock('../src/notifications/notifier.js', () => ({ notifyUsers: n.notifyUsers, formatDate: () => '19:00' }));

const { handlers } = await import('../src/messaging/handlers.js');

function fakeDb() {
  const find = vi.fn(() => ({
    limit: () => ({ toArray: async () => [] }),
  }));
  const col = {
    updateOne: vi.fn(async () => ({})),
    find,
  };
  return { db: { collection: () => col }, find };
}

const event = {
  eventId: 'e1',
  organizerId: 'org1',
  title: 'Concierto',
  category: 'musical',
  startsAt: '2026-12-01T19:00:00Z',
  endsAt: '2026-12-01T22:00:00Z',
  status: 'published',
  isLive: false,
  venue: { name: 'Auditorio', location: { lat: 4.6, lng: -74.07 } },
};

describe('event.published: avisos cercanos', () => {
  it('filtra por la categoría entre los intereses, sin incluir usuarios sin intereses', async () => {
    const { db, find } = fakeDb();
    await handlers['event.published'](event, { eventType: 'event.published' }, db);
    const filter = find.mock.calls[0][0];
    expect(filter.interests).toBe('musical');
    expect(filter.$or).toBeUndefined();
  });
});
