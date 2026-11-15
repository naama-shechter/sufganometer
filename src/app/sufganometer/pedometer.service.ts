import { Injectable, NgZone, computed, inject, signal } from '@angular/core';
import { Capacitor, PluginListenerHandle } from '@capacitor/core';
import { App } from '@capacitor/app';
import { CapacitorPedometer } from '@capgo/capacitor-pedometer';
import { DonutType, EatenDonut, computeStatus } from './donut-calc';

export type SensorState =
  | 'checking'
  | 'needs-permission'
  | 'denied'
  | 'unsupported'
  | 'live'
  | 'web'
  | 'error';

interface SavedState {
  eaten: EatenDonut[];
  steps: number;
  sessionStart: number;
}

const STORAGE_KEY = 'sufganometer.v1';

/**
 * מחבר את מד הצעדים המובנה של הטלפון (iOS: CMPedometer, Android: TYPE_STEP_COUNTER)
 * וסופר צעדים מאז שהתחיל "חוב הסופגניות" הנוכחי.
 *
 * iOS  – הצעדים נשמרים במערכת (עד 7 ימים אחורה), לכן בכל חזרה לאפליקציה
 *        שולפים את סך הצעדים מאז הסופגנייה הראשונה, כולל כשהאפליקציה הייתה סגורה.
 * Android – לתוסף אין שאילתה היסטורית, לכן נספרים רק צעדים בזמן שהאפליקציה פתוחה,
 *        והסכום נשמר מקומית בין הפעלות.
 */
@Injectable({ providedIn: 'root' })
export class PedometerService {
  private readonly zone = inject(NgZone);

  readonly kcalPerStep = 0.04;
  readonly isNative = Capacitor.isNativePlatform();
  readonly isIos = Capacitor.getPlatform() === 'ios';

  readonly sensor = signal<SensorState>('checking');
  readonly steps = signal(0);
  readonly eaten = signal<EatenDonut[]>([]);
  readonly simulating = signal(false);

  readonly status = computed(() => computeStatus(this.eaten(), this.steps(), this.kcalPerStep));

  private sessionStart = 0;
  private baseSteps = 0; // צעדים שנספרו לפני הסשן החי הנוכחי של החיישן
  private lastLive = 0; // הערך האחרון שהחיישן דיווח בסשן הנוכחי (מצטבר מתחילת הסשן)
  private liveOffset = 0; // לאיפוס באמצע סשן חי (סופגנייה חדשה אחרי שהחוב נמחק)
  private measurementListener?: PluginListenerHandle;
  private wantLive = false;
  private initialized = false;
  private simTimer?: ReturnType<typeof setInterval>;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.load();

    if (!this.isNative) {
      this.sensor.set('web');
      return;
    }

    try {
      const availability = await CapacitorPedometer.isAvailable();
      if (!availability.stepCounting) {
        this.sensor.set('unsupported');
        return;
      }

      await App.addListener('pause', () => void this.onPause());
      await App.addListener('resume', () => void this.onResume());

      const perm = await CapacitorPedometer.checkPermissions();
      if (perm.activityRecognition === 'granted') {
        await this.startLive();
      } else {
        this.sensor.set(perm.activityRecognition === 'denied' ? 'denied' : 'needs-permission');
      }
    } catch (err) {
      console.error('[Sufganometer] pedometer init failed', err);
      this.sensor.set('error');
    }
  }

  /** נקרא מכפתור "חבר למד הצעדים" */
  async connect(): Promise<void> {
    try {
      const perm = await CapacitorPedometer.requestPermissions();
      if (perm.activityRecognition === 'granted') {
        await this.startLive();
      } else {
        this.sensor.set('denied');
      }
    } catch (err) {
      console.error('[Sufganometer] permission request failed', err);
      this.sensor.set('error');
    }
  }

  eat(type: DonutType): void {
    const donut: EatenDonut = { typeId: type.id, kcal: type.kcal, at: Date.now() };
    if (this.status().done) {
      // אין חוב פתוח – מתחילים סשן חדש מאפס
      this.sessionStart = donut.at;
      this.resetCounter();
      this.eaten.set([donut]);
    } else {
      this.eaten.update((list) => [...list, donut]);
    }
    this.save();
  }

  reset(): void {
    this.stopSimulation();
    this.sessionStart = 0;
    this.resetCounter();
    this.eaten.set([]);
    this.save();
  }

  /** הדמיה לדפדפן בלבד – אין שם חיישן אמיתי */
  toggleSimulation(): void {
    if (this.simulating()) {
      this.stopSimulation();
      return;
    }
    this.simulating.set(true);
    this.simTimer = setInterval(() => {
      this.steps.update((s) => s + 18 + Math.floor(Math.random() * 14));
    }, 200);
  }

  // ---------- חיישן ----------

  private async startLive(): Promise<void> {
    this.wantLive = true;
    await this.stopLiveUpdates();
    await this.syncBaseFromSystem();

    this.lastLive = 0;
    this.liveOffset = 0;
    this.measurementListener = await CapacitorPedometer.addListener('measurement', (m) => {
      this.zone.run(() => {
        this.lastLive = Math.max(0, m.numberOfSteps ?? 0);
        this.steps.set(this.baseSteps + this.lastLive - this.liveOffset);
        this.save();
      });
    });
    await CapacitorPedometer.startMeasurementUpdates();
    this.sensor.set('live');
  }

  private async stopLiveUpdates(): Promise<void> {
    try {
      await CapacitorPedometer.stopMeasurementUpdates();
    } catch {
      /* לא היה סשן פעיל */
    }
    await this.measurementListener?.remove();
    this.measurementListener = undefined;
  }

  /** באייפון: שולף מהמערכת את כל הצעדים מאז תחילת החוב (גם כשהאפליקציה הייתה סגורה) */
  private async syncBaseFromSystem(): Promise<void> {
    if (this.isIos && this.sessionStart > 0) {
      try {
        const m = await CapacitorPedometer.getMeasurement({ start: this.sessionStart, end: Date.now() });
        this.steps.set(m.numberOfSteps ?? 0);
      } catch (err) {
        console.warn('[Sufganometer] history query failed, using saved steps', err);
      }
    }
    this.baseSteps = this.steps();
  }

  private async onPause(): Promise<void> {
    this.save();
    if (this.wantLive) await this.stopLiveUpdates();
  }

  private async onResume(): Promise<void> {
    if (this.wantLive) {
      await this.startLive();
      return;
    }
    // אולי המשתמשת אישרה הרשאה בהגדרות ואז חזרה
    if (this.sensor() === 'denied' || this.sensor() === 'needs-permission') {
      const perm = await CapacitorPedometer.checkPermissions();
      if (perm.activityRecognition === 'granted') await this.startLive();
    }
  }

  private resetCounter(): void {
    this.baseSteps = 0;
    this.liveOffset = this.lastLive;
    this.steps.set(0);
  }

  private stopSimulation(): void {
    if (this.simTimer) clearInterval(this.simTimer);
    this.simTimer = undefined;
    this.simulating.set(false);
  }

  // ---------- שמירה מקומית ----------

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as SavedState;
      this.eaten.set(saved.eaten ?? []);
      this.steps.set(saved.steps ?? 0);
      this.sessionStart = saved.sessionStart ?? 0;
    } catch {
      /* נתונים פגומים – מתחילים מחדש */
    }
  }

  private save(): void {
    const state: SavedState = {
      eaten: this.eaten(),
      steps: this.steps(),
      sessionStart: this.sessionStart,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* אחסון לא זמין */
    }
  }
}
