# festa-notification-service

RF12: notificaciones push con Firebase Cloud Messaging, bandeja de notificaciones en la app y recordatorios de
asistencia. Node 20 / Express con MongoDB (`notification_db`). Puerto 8087.

## Qué hace

Consume los eventos de los demás servicios (ver `festa-infra/contracts/README.md` § notification) y decide a quién
avisar:

| Mensaje | Aviso |
|---|---|
| `event.published` | Push a usuarios **cercanos** (radio `NEARBY_RADIUS_METERS`), con consentimiento de ubicación (RNF5), ubicación reciente e intereses afines. Los Parches en Vivo llevan 🔥 |
| `attendance.confirmed` | Confirmación al usuario y recordatorio `REMINDER_HOURS_BEFORE` horas antes del evento |
| `event.rescheduled` / `event.cancelled` | A los asistentes confirmados (reprograma o anula recordatorios) |
| `pass.checked_in` | Bienvenida al entrar |
| `order.*`, `payout.recorded` | Recibo, pago fallido, reserva vencida, reembolsos, liquidaciones |
| `merchant.submitted`, `report.created` | A los administradores |
| `merchant.verified` / `merchant.rejected`, `report.resolved` | Al comercio o a quien reportó |
| `account.*`, `profile.updated`, `location_consent.*`, `moderation.user_*` | Mantienen el estado local de cada usuario (rol, intereses, consentimiento, suspensión). `account.deleted` borra todo (Ley 1581) |

Cada aviso queda en la bandeja del usuario y, si tiene dispositivos registrados, se envía por FCM. Publica
`push.sent` (alcance) para analytics. Sin cuenta de servicio de Firebase (o con el placeholder `{}` que crea
`festa-infra/scripts/gen-secrets.sh`) funciona en modo **solo bandeja**.

**Idempotencia sin transacciones:** el `_id` de cada notificación y de cada fila del outbox se deriva del `eventId` que
la causó, así que reprocesar un mensaje no envía dos push ni publica dos veces.

## API

Todas con JWT. El cliente las llama con el prefijo `/api`.

| Método y ruta | Qué hace |
|---|---|
| `POST /notifications/devices` `{token, platform}` | Registra el token FCM del dispositivo (máx. 5 por usuario) |
| `DELETE /notifications/devices` `{token}` | Lo quita (cerrar sesión) |
| `PUT /notifications/location` `{lat, lng}` | Última ubicación para avisos cercanos. **403** sin consentimiento |
| `DELETE /notifications/location` | Borra la ubicación |
| `GET /notifications?limit=30&before=<iso>&unread=true` | Bandeja |
| `GET /notifications/unread-count` | Contador de no leídas |
| `POST /notifications/{id}/read`, `POST /notifications/read-all` | Marcar como leídas |
| `GET /health`, `GET /metrics` | Estado y métricas |

## Correr en local

```bash
cp .env.example .env
npm ci
npm test                                                  # unitarias
TEST_MONGO_URL=mongodb://localhost:27018/notif_test npm test   # + integración con Mongo real
npm start
```

Con el resto del stack: `docker compose --profile notification up -d --build` desde `festa-infra`.
