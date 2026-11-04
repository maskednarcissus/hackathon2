import { randomUUID } from 'node:crypto';
import type { AlertAuditAction, AuditClient } from './audit.js';
import type { OrganizationClient } from './incidents/organization.js';
import type { AlertNotification, NotificationChannel, RecipientDirectory } from './channels.js';
import {
  ALERT_POLICY,
  SEVERITY_RANK,
  dedupeKey,
  type Alert,
  type AlertCondition,
  type AlertRule,
  type IncidentComment,
  type ResolutionCode,
  slaDueAt,
} from './domain.js';
import type { ClassWindow, DeviceSnapshot, EvaluateRequest, EventEnvelope } from './schemas.js';
import type { AlertStore } from './store.js';

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface EngineDeps {
  store: AlertStore;
  channels: NotificationChannel[];
  recipients: RecipientDirectory;
  audit: AuditClient;
  clock: () => Date;
  logger: Logger;
  organization?: OrganizationClient | undefined;
}

/** Domain error for incident workflow violations (mapped to HTTP by the routes). */
export class IncidentError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface EngineResult {
  raised: Alert[];
  updated: Alert[];
  resolved: Alert[];
}

type ClearSpec = { rule: AlertRule; resourceId: string };

const emptyResult = (): EngineResult => ({ raised: [], updated: [], resolved: [] });
const merge = (a: EngineResult, b: EngineResult): EngineResult => ({
  raised: [...a.raised, ...b.raised],
  updated: [...a.updated, ...b.updated],
  resolved: [...a.resolved, ...b.resolved],
});

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * Recording-failure alert engine (deliverable 1.17).
 *
 * * Event-driven rules run on `POST /v1/lifecycle-events`.
 * * Time-based rules run on `POST /v1/alerts/evaluate` (called every minute by Cloud Scheduler
 *   with the current class windows and device snapshots).
 * * Alerts are deduplicated by `(rule, resourceId)` while unresolved, re-notified at most every
 *   30 minutes while still `open`, escalated immediately when severity increases and
 *   auto-resolved when the condition clears.
 */
export class AlertEngine {
  constructor(private readonly deps: EngineDeps) {}

  // ------------------------------------------------------------------ events
  async handleEvent(event: EventEnvelope): Promise<EngineResult> {
    const d = event.data;
    const institutionId = event.institutionId ?? str(d.institutionId);
    const base = {
      institutionId,
      classroomId: str(d.classroomId),
      deviceId: str(d.deviceId),
      scheduledClassId: str(d.scheduledClassId),
      recordingSessionId: str(d.recordingSessionId),
    };
    const raise: AlertCondition[] = [];
    const clear: ClearSpec[] = [];

    switch (event.type) {
      case 'recording.started': {
        if (base.scheduledClassId) {
          await this.deps.store.markClass(base.scheduledClassId, 'recording_started');
          clear.push({ rule: 'recording_missed', resourceId: base.scheduledClassId });
        }
        break;
      }
      case 'recording.uploaded':
      case 'upload.completed': {
        if (base.scheduledClassId) {
          await this.deps.store.markClass(base.scheduledClassId, 'recording_started');
          await this.deps.store.markClass(base.scheduledClassId, 'uploaded');
          clear.push({ rule: 'recording_missed', resourceId: base.scheduledClassId });
          clear.push({ rule: 'failed_upload', resourceId: base.scheduledClassId });
        }
        if (base.recordingSessionId) {
          clear.push({ rule: 'failed_upload', resourceId: base.recordingSessionId });
        }
        break;
      }
      case 'upload.failed': {
        const resourceId = base.recordingSessionId ?? str(d.uploadId);
        if (resourceId) {
          raise.push({
            ...base,
            rule: 'failed_upload',
            resourceType: 'recording_session',
            resourceId,
            severity: 'medium',
            title: 'Falha no envio de gravação',
            message: `O envio da gravação ${resourceId} falhou: ${str(d.reason) ?? 'motivo desconhecido'}.`,
            details: { uploadId: str(d.uploadId), reason: str(d.reason) },
          });
        }
        break;
      }
      case 'audio.quality_assessed': {
        const report = (d.report ?? {}) as Record<string, unknown>;
        const verdict = str(report.verdict);
        const resourceId = base.recordingSessionId;
        if (!resourceId) break;
        if (verdict === 'poor' || verdict === 'unusable') {
          raise.push({
            ...base,
            rule: 'poor_audio_quality',
            resourceType: 'recording_session',
            resourceId,
            severity: verdict === 'unusable' ? 'high' : 'medium',
            title: verdict === 'unusable' ? 'Áudio inutilizável' : 'Qualidade de áudio baixa',
            message: `Gravação ${resourceId}: qualidade "${verdict}" (${
              Array.isArray(report.issues) ? report.issues.join(', ') : 'sem detalhes'
            }).`,
            details: { report },
          });
        } else if (verdict) {
          clear.push({ rule: 'poor_audio_quality', resourceId });
        }
        break;
      }
      case 'transcription.failed': {
        const resourceId = base.recordingSessionId;
        if (resourceId) {
          raise.push({
            ...base,
            rule: 'transcription_failure',
            resourceType: 'recording_session',
            resourceId,
            severity: 'medium',
            title: 'Falha na transcrição',
            message: `A transcrição da gravação ${resourceId} falhou: ${str(d.reason) ?? 'motivo desconhecido'}.`,
            details: { reason: str(d.reason) },
          });
        }
        break;
      }
      case 'transcription.completed': {
        if (base.recordingSessionId) {
          clear.push({ rule: 'transcription_failure', resourceId: base.recordingSessionId });
        }
        break;
      }
      case 'device.heartbeat_missed': {
        if (base.deviceId) {
          raise.push({
            ...base,
            rule: 'device_offline',
            resourceType: 'device',
            resourceId: base.deviceId,
            severity: 'medium',
            title: 'Dispositivo sem comunicação',
            message: `O dispositivo ${base.deviceId} não envia heartbeat desde ${str(d.lastSeenAt) ?? '—'}.`,
            details: { lastSeenAt: str(d.lastSeenAt) },
          });
        }
        break;
      }
      case 'recording.missed': {
        if (base.scheduledClassId) {
          raise.push({
            ...base,
            rule: 'recording_missed',
            resourceType: 'scheduled_class',
            resourceId: base.scheduledClassId,
            severity: 'high',
            title: 'Aula não gravada',
            message: `A aula ${base.scheduledClassId} não está sendo gravada.`,
          });
        }
        break;
      }
      default:
        break;
    }
    return this.apply(raise, clear, this.deps.clock());
  }

  // ------------------------------------------------------------------ time-based
  async evaluate(input: EvaluateRequest): Promise<EngineResult> {
    const now = input.now ? new Date(input.now) : this.deps.clock();
    const raise: AlertCondition[] = [];
    const clear: ClearSpec[] = [];
    const windows = input.classWindows.filter((w) => w.recordingEnabled !== false);

    for (const device of input.devices) this.evaluateDevice(device, windows, now, raise, clear);
    for (const window of windows) {
      const started = await this.deps.store.hasClassMark(
        window.scheduledClassId,
        'recording_started',
      );
      const uploaded = await this.deps.store.hasClassMark(window.scheduledClassId, 'uploaded');
      this.evaluateWindow(window, now, started, uploaded, raise, clear);
    }

    return this.apply(raise, clear, now);
  }

  private evaluateDevice(
    device: DeviceSnapshot,
    windows: ClassWindow[],
    now: Date,
    raise: AlertCondition[],
    clear: ClearSpec[],
  ): void {
    const base = {
      deviceId: device.deviceId,
      classroomId: device.classroomId ?? null,
      institutionId: device.institutionId ?? null,
    };
    const lastSeen = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : null;
    const silentMs = lastSeen === null ? Number.POSITIVE_INFINITY : now.getTime() - lastSeen;
    const activeWindow = windows.find(
      (w) =>
        (w.deviceId === device.deviceId ||
          (device.classroomId != null && w.classroomId === device.classroomId)) &&
        new Date(w.recordStartAt) <= now &&
        now < new Date(w.recordStopAt),
    );
    const decommissioned = device.status === 'decommissioned' || device.status === 'maintenance';

    if (
      !decommissioned &&
      silentMs > ALERT_POLICY.offlineAfterMs &&
      (activeWindow || silentMs > ALERT_POLICY.offlineOutsideWindowAfterMs)
    ) {
      const minutes = Number.isFinite(silentMs) ? Math.floor(silentMs / 60_000) : null;
      raise.push({
        ...base,
        rule: 'device_offline',
        resourceType: 'device',
        resourceId: device.deviceId,
        severity: activeWindow ? 'high' : 'low',
        scheduledClassId: activeWindow?.scheduledClassId ?? null,
        title: activeWindow ? 'Dispositivo offline durante aula' : 'Dispositivo offline',
        message:
          minutes === null
            ? `O dispositivo ${device.deviceId} nunca enviou heartbeat.`
            : `O dispositivo ${device.deviceId} está sem comunicação há ${minutes} min${
                activeWindow ? ` durante a aula ${activeWindow.scheduledClassId}` : ''
              }.`,
        details: { lastSeenAt: device.lastSeenAt, silentMinutes: minutes },
      });
    } else if (silentMs <= ALERT_POLICY.offlineAfterMs || decommissioned) {
      clear.push({ rule: 'device_offline', resourceId: device.deviceId });
    }

    if (device.diskFreeBytes != null) {
      if (device.diskFreeBytes < ALERT_POLICY.lowStorageBytes) {
        raise.push({
          ...base,
          rule: 'low_storage',
          resourceType: 'device',
          resourceId: device.deviceId,
          severity: 'medium',
          title: 'Armazenamento local baixo',
          message: `O dispositivo ${device.deviceId} tem ${(device.diskFreeBytes / 1024 ** 2).toFixed(0)} MiB livres.`,
          details: { diskFreeBytes: device.diskFreeBytes },
        });
      } else {
        clear.push({ rule: 'low_storage', resourceId: device.deviceId });
      }
    }
  }

  private evaluateWindow(
    w: ClassWindow,
    now: Date,
    started: boolean,
    uploaded: boolean,
    raise: AlertCondition[],
    clear: ClearSpec[],
  ): void {
    const start = new Date(w.recordStartAt).getTime();
    const stop = new Date(w.recordStopAt).getTime();
    const base = {
      classroomId: w.classroomId,
      deviceId: w.deviceId ?? null,
      institutionId: w.institutionId ?? null,
      scheduledClassId: w.scheduledClassId,
    };

    if (started) {
      clear.push({ rule: 'recording_missed', resourceId: w.scheduledClassId });
    } else if (now.getTime() >= start + ALERT_POLICY.missedRecordingGraceMs) {
      raise.push({
        ...base,
        rule: 'recording_missed',
        resourceType: 'scheduled_class',
        resourceId: w.scheduledClassId,
        severity: 'high',
        title: 'Aula não gravada',
        message: `Nenhuma gravação iniciada para a aula ${w.scheduledClassId} na sala ${w.classroomId}.`,
        details: { recordStartAt: w.recordStartAt, recordStopAt: w.recordStopAt },
      });
    }

    if (uploaded) {
      clear.push({ rule: 'failed_upload', resourceId: w.scheduledClassId });
    } else if (started && now.getTime() >= stop + ALERT_POLICY.uploadOverdueMs) {
      raise.push({
        ...base,
        rule: 'failed_upload',
        resourceType: 'scheduled_class',
        resourceId: w.scheduledClassId,
        severity: 'medium',
        title: 'Envio de gravação atrasado',
        message: `A gravação da aula ${w.scheduledClassId} não foi recebida 2 h após o término.`,
        details: { recordStopAt: w.recordStopAt },
      });
    }
  }

  // ------------------------------------------------------------------ state changes
  private async apply(
    raise: AlertCondition[],
    clear: ClearSpec[],
    now: Date,
  ): Promise<EngineResult> {
    let result = emptyResult();
    const raisedKeys = new Set<string>();
    for (const condition of raise) {
      raisedKeys.add(dedupeKey(condition.rule, condition.resourceId));
      result = merge(result, await this.raise(condition, now));
    }
    for (const spec of clear) {
      const key = dedupeKey(spec.rule, spec.resourceId);
      if (raisedKeys.has(key)) continue;
      const resolved = await this.autoResolve(key, now);
      if (resolved) result.resolved.push(resolved);
    }
    return result;
  }

  private async raise(c: AlertCondition, now: Date): Promise<EngineResult> {
    const { store } = this.deps;
    const key = dedupeKey(c.rule, c.resourceId);
    const nowIso = now.toISOString();
    const existing = await store.findActive(key);

    if (!existing) {
      const alert: Alert = {
        id: randomUUID(),
        rule: c.rule,
        dedupeKey: key,
        resourceType: c.resourceType,
        resourceId: c.resourceId,
        institutionId: c.institutionId ?? null,
        classroomId: c.classroomId ?? null,
        campusId: null,
        classroomName: null,
        campusName: null,
        deviceId: c.deviceId ?? null,
        scheduledClassId: c.scheduledClassId ?? null,
        recordingSessionId: c.recordingSessionId ?? null,
        severity: c.severity,
        status: 'open',
        title: c.title,
        message: c.message,
        details: c.details ?? {},
        firstRaisedAt: nowIso,
        lastSeenAt: nowIso,
        lastNotifiedAt: null,
        notificationCount: 0,
        occurrences: 1,
        acknowledgedAt: null,
        acknowledgedBy: null,
        resolvedAt: null,
        resolvedBy: null,
        resolution: null,
        resolutionNote: null,
        assigneeId: null,
        assignedAt: null,
        inProgressAt: null,
        resolutionCode: null,
        slaDueAt: slaDueAt(nowIso, c.severity),
      };
      await this.locate(alert);
      await this.notify(alert, 'raised', now);
      await store.save(alert);
      await this.audit('alert.raised', alert, null, { rule: alert.rule, severity: alert.severity });
      await this.activity(alert, 'raised', null, alert.message, now);
      this.deps.logger.warn(
        { alertId: alert.id, rule: alert.rule, resourceId: alert.resourceId },
        'alert raised',
      );
      return { ...emptyResult(), raised: [alert] };
    }

    const escalated = SEVERITY_RANK[c.severity] > SEVERITY_RANK[existing.severity];
    const alert: Alert = {
      ...existing,
      severity: escalated ? c.severity : existing.severity,
      title: escalated ? c.title : existing.title,
      message: c.message,
      details: { ...existing.details, ...(c.details ?? {}) },
      classroomId: existing.classroomId ?? c.classroomId ?? null,
      deviceId: existing.deviceId ?? c.deviceId ?? null,
      institutionId: existing.institutionId ?? c.institutionId ?? null,
      scheduledClassId: c.scheduledClassId ?? existing.scheduledClassId,
      lastSeenAt: nowIso,
      occurrences: existing.occurrences + 1,
    };
    if (!alert.campusId) await this.locate(alert);
    if (escalated) {
      // escalation tightens the SLA, re-opens an acknowledged alert (work already in
      // progress stays in progress) and notifies immediately
      alert.slaDueAt = slaDueAt(alert.firstRaisedAt, alert.severity);
      if (alert.status === 'acknowledged') alert.status = 'open';
      await this.notify(alert, 'escalated', now);
      await this.audit('alert.escalated', alert, null, {
        from: existing.severity,
        to: alert.severity,
      });
      await this.activity(
        alert,
        'escalated',
        null,
        `${existing.severity} → ${alert.severity}`,
        now,
      );
    } else if (alert.status === 'open' && this.cooldownElapsed(alert, now)) {
      await this.notify(alert, 'reminder', now);
    }
    await store.save(alert);
    return { ...emptyResult(), updated: [alert] };
  }

  private cooldownElapsed(alert: Alert, now: Date): boolean {
    if (!alert.lastNotifiedAt) return true;
    return (
      now.getTime() - new Date(alert.lastNotifiedAt).getTime() >= ALERT_POLICY.renotifyCooldownMs
    );
  }

  private async autoResolve(key: string, now: Date): Promise<Alert | undefined> {
    const existing = await this.deps.store.findActive(key);
    if (!existing) return undefined;
    const alert: Alert = {
      ...existing,
      status: 'resolved',
      resolvedAt: now.toISOString(),
      resolvedBy: null,
      resolution: 'auto',
      resolutionNote: 'Condição normalizada',
    };
    await this.deps.store.save(alert);
    await this.notify(alert, 'resolved', now, false);
    await this.audit('alert.resolved', alert, null, { resolution: 'auto' });
    await this.activity(alert, 'resolved', null, 'auto: condição normalizada', now);
    return alert;
  }

  private async load(id: string): Promise<Alert> {
    const alert = await this.deps.store.get(id);
    if (!alert) throw new IncidentError(404, 'not_found', 'Incident not found');
    return alert;
  }

  private assertOpen(alert: Alert): void {
    if (alert.status === 'resolved') {
      throw new IncidentError(409, 'incident_resolved', 'Incident is already resolved');
    }
  }

  async get(id: string): Promise<Alert | undefined> {
    return this.deps.store.get(id);
  }

  /** open → acknowledged (idempotent for acknowledged / in_progress). */
  async acknowledge(id: string, actorId: string, note?: string): Promise<Alert | undefined> {
    const alert = await this.deps.store.get(id);
    if (!alert) return undefined;
    if (alert.status !== 'open') return alert;
    const now = this.deps.clock();
    const updated: Alert = {
      ...alert,
      status: 'acknowledged',
      acknowledgedAt: now.toISOString(),
      acknowledgedBy: actorId,
      resolutionNote: note ?? alert.resolutionNote,
    };
    await this.deps.store.save(updated);
    await this.audit('alert.acknowledged', updated, actorId, { note: note ?? null });
    await this.activity(updated, 'acknowledged', actorId, note ?? null, now);
    return updated;
  }

  /** open | acknowledged → in_progress. Counts as acknowledgement for MTTA. */
  async startProgress(id: string, actorId: string, note?: string): Promise<Alert> {
    const alert = await this.load(id);
    this.assertOpen(alert);
    if (alert.status === 'in_progress') return alert;
    const now = this.deps.clock().toISOString();
    const updated: Alert = {
      ...alert,
      status: 'in_progress',
      inProgressAt: now,
      acknowledgedAt: alert.acknowledgedAt ?? now,
      acknowledgedBy: alert.acknowledgedBy ?? actorId,
      // whoever starts working on an unassigned incident owns it
      assigneeId: alert.assigneeId ?? actorId,
      assignedAt: alert.assignedAt ?? now,
    };
    await this.deps.store.save(updated);
    await this.audit('alert.in_progress', updated, actorId, { note: note ?? null });
    await this.activity(updated, 'in_progress', actorId, note ?? null, new Date(now));
    return updated;
  }

  async assign(id: string, assigneeId: string, actorId: string): Promise<Alert> {
    const alert = await this.load(id);
    this.assertOpen(alert);
    if (alert.assigneeId === assigneeId) return alert;
    const now = this.deps.clock();
    const updated: Alert = { ...alert, assigneeId, assignedAt: now.toISOString() };
    await this.deps.store.save(updated);
    await this.audit('alert.assigned', updated, actorId, {
      assigneeId,
      previousAssigneeId: alert.assigneeId,
    });
    await this.activity(updated, 'assigned', actorId, assigneeId, now);
    return updated;
  }

  async comment(
    id: string,
    actorId: string,
    body: string,
  ): Promise<{ alert: Alert; comment: IncidentComment }> {
    const alert = await this.load(id);
    const now = this.deps.clock();
    const comment: IncidentComment = {
      id: randomUUID(),
      alertId: alert.id,
      actorId,
      body,
      createdAt: now.toISOString(),
    };
    await this.deps.store.addComment(comment);
    await this.audit('alert.commented', alert, actorId, {
      commentId: comment.id,
      length: body.length,
    });
    await this.activity(alert, 'commented', actorId, null, now);
    return { alert, comment };
  }

  /**
   * Manual resolution. The incident API requires a `resolutionCode` (Phase 4 §4); the
   * Phase 1 alert API (`/v1/alerts/:id/resolve`) still accepts none for compatibility.
   */
  async resolve(
    id: string,
    actorId: string,
    note?: string,
    resolutionCode?: ResolutionCode,
  ): Promise<Alert | undefined> {
    const alert = await this.deps.store.get(id);
    if (!alert) return undefined;
    if (alert.status === 'resolved') return alert;
    const now = this.deps.clock();
    const updated: Alert = {
      ...alert,
      status: 'resolved',
      resolvedAt: now.toISOString(),
      resolvedBy: actorId,
      resolution: 'manual',
      resolutionCode: resolutionCode ?? null,
      resolutionNote: note ?? null,
    };
    await this.deps.store.save(updated);
    await this.notify(updated, 'resolved', now, false);
    await this.audit('alert.resolved', updated, actorId, {
      resolution: 'manual',
      resolutionCode: resolutionCode ?? null,
      note: note ?? null,
    });
    await this.activity(updated, 'resolved', actorId, resolutionCode ?? null, now);
    return updated;
  }

  /** Fills campus / names / institution from the classroom (best effort). */
  private async locate(alert: Alert): Promise<void> {
    if (!alert.classroomId || !this.deps.organization) return;
    const loc = await this.deps.organization.locateClassroom(alert.classroomId);
    if (!loc) return;
    alert.campusId = loc.campusId;
    alert.campusName = loc.campusName;
    alert.classroomName = loc.classroomName;
    alert.institutionId = alert.institutionId ?? loc.institutionId;
  }

  private async activity(
    alert: Alert,
    action: string,
    actorId: string | null,
    detail: string | null,
    at: Date,
  ): Promise<void> {
    await this.deps.store.addActivity({
      alertId: alert.id,
      at: at.toISOString(),
      action,
      actorId,
      detail,
    });
  }

  // ------------------------------------------------------------------ side effects
  /** Delivers to every matching recipient. Failures are recorded, never thrown. */
  private async notify(
    alert: Alert,
    kind: AlertNotification['kind'],
    now: Date,
    countsAsNotification = true,
  ): Promise<void> {
    const recipients = this.deps.recipients.recipientsFor(alert.institutionId, alert.severity);
    const prefix = {
      raised: 'ALERTA',
      reminder: 'LEMBRETE',
      escalated: 'ESCALADO',
      resolved: 'RESOLVIDO',
    }[kind];
    const subject = `[${prefix}][${alert.severity.toUpperCase()}] ${alert.title}`;
    const text = [
      alert.message,
      '',
      `Regra: ${alert.rule}`,
      `Recurso: ${alert.resourceType} ${alert.resourceId}`,
      alert.classroomId ? `Sala: ${alert.classroomId}` : null,
      alert.deviceId ? `Dispositivo: ${alert.deviceId}` : null,
      `Desde: ${alert.firstRaisedAt}`,
      `Alerta: ${alert.id}`,
    ]
      .filter((l): l is string => l !== null)
      .join('\n');

    for (const recipient of recipients) {
      const channel = this.deps.channels.find((c) => c.name === recipient.channel);
      const attemptedAt = now.toISOString();
      if (!channel) {
        await this.deps.store.addDelivery({
          alertId: alert.id,
          channel: recipient.channel,
          recipient: recipient.address,
          status: 'failed',
          error: 'channel not configured',
          attemptedAt,
        });
        continue;
      }
      try {
        await channel.send({ alert, kind, recipient: recipient.address, subject, text });
        await this.deps.store.addDelivery({
          alertId: alert.id,
          channel: channel.name,
          recipient: recipient.address,
          status: 'sent',
          error: null,
          attemptedAt,
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.deps.logger.error(
          { alertId: alert.id, channel: channel.name, error },
          'alert delivery failed',
        );
        await this.deps.store.addDelivery({
          alertId: alert.id,
          channel: channel.name,
          recipient: recipient.address,
          status: 'failed',
          error,
          attemptedAt,
        });
      }
    }
    if (countsAsNotification) {
      alert.lastNotifiedAt = now.toISOString();
      alert.notificationCount += 1;
    }
  }

  private async audit(
    action: AlertAuditAction,
    alert: Alert,
    actorId: string | null,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deps.audit.record({
        action,
        institutionId: alert.institutionId,
        actorType: actorId ? 'admin' : 'system',
        actorId,
        resourceType: 'alert',
        resourceId: alert.id,
        metadata: {
          ...metadata,
          dedupeKey: alert.dedupeKey,
          resourceType: alert.resourceType,
          resourceId: alert.resourceId,
        },
        occurredAt: this.deps.clock().toISOString(),
      });
    } catch (err) {
      this.deps.logger.warn(
        { alertId: alert.id, action, error: err instanceof Error ? err.message : String(err) },
        'audit write failed (non-fatal)',
      );
    }
  }
}
