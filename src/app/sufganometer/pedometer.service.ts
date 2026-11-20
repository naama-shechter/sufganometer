import { Injectable, NgZone, computed, inject, signal } from '@angular/core';
import { Capacitor, PluginListenerHandle } from '@capacitor/core';
import { App } from '@capacitor/app';
import { CapacitorPedometer } from '@capgo/capacitor-pedometer';
import { DonutType, EatenDonut, computeStatus, distribute, stepsFor } from './donut-calc';

export type SensorState =
  | 'checking'
  | 'needs-permission'
  | 'denied'
  | 'unsupported'
  | 'live'
  | 'web'
  | 'error';

/** מה קרה לבנק כשהוספנו סופגנייה – לחלון ההודעה */
export type BankOutcome =
  | { kind: 'none' }
  | { kind: 'free'; need: number; bankLeft: number }
  | { kind: 'partial'; used: number; left: number };

interface SavedState {
  eaten: EatenDonut[];
  steps: number;
  bank: number;
  focus: number | null;
  trackingStart: number;
}

const STORAGE_KEY = 'sufganometer.v3';

/**
 * מחבר את מד הצעדים המובנה של הטלפון (iOS: CMPedometer, Android: TYPE_STEP_COUNTER)
 * וסופר צעדים מאז תחילת המעקב. כל צעד חדש הולך לסופגנייה הפעילה (זו שמוצגת בדשבורד),
 * לכל סופגנייה נשמר מה שכבר נספר לה, ומה שנשאר אחרי כולן נשמר בבנק לסופגנייה הבאה.
 *
 * iOS  – בכל חזרה לאפליקציה שולפים מהמערכת את כל הצעדים מאז תחילת המעקב
 *        (עד 7 ימים אחורה), כולל כשהאפליקציה הייתה סגורה.
 * Android – נספרים רק צעדים בזמן שהאפליקציה פתוחה, והסכום נשמר מקומית.
 */
@Injectable({ providedIn: 'root' })
export class PedometerService {
  private readonly zone = inject(NgZone);

  readonly kcalPerStep = 0.04;
  readonly isNative = Capacitor.isNativePlatform();
  readonly isIos = Capacitor.getPlatform() === 'ios';

  readonly sensor = signal<SensorState>('checking');
  /** סך הצעדים שנספרו מאז תחילת המעקב (לתצוגה ולסנכרון מול החיישן) */
  readonly steps = signal(0);
  readonly eaten = signal<EatenDonut[]>([]);
  /** צעדים שלא שויכו לאף סופגנייה */
  readonly bank = signal(0);
  /** איזו סופגנייה מהתור נבחרה לשריפה (null = הראשונה שעוד לא נשרפה) */
  readonly focus = signal<number | null>(null);
  readonly simulating = signal(false);

  readonly status = computed(() => computeStatus(this.eaten(), this.bank(), this.kcalPerStep, this.focus()));

  private trackingStart = 0;
  private baseSteps = 0;
  private lastLive = 0;
  private liveOffset = 0;
  private measurementListener?: PluginListenerHandle;
  private wantLive = false;
  private initialized = false;
  private simTimer?: ReturnType<typeof setInterval>;

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.load();
    if (!this.trackingStart) {
      this.trackingStart = Date.now();
      this.save();
    }

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

  /** "אכלתי עוד" – מוסיף לסוף התור, ומקזז קודם מהבנק */
  eat(type: DonutType): BankOutcome {
    const bank = this.bank();
    const need = stepsFor(type, this.kcalPerStep);
    const fromBank = Math.min(bank, need);
    this.eaten.update((list) => [...list, { typeId: type.id, at: Date.now(), credited: fromBank }]);
    this.bank.set(bank - fromBank);
    this.save();

    if (bank <= 0) return { kind: 'none' };
    return bank >= need
      ? { kind: 'free', need, bankLeft: bank - need }
      : { kind: 'partial', used: bank, left: need - bank };
  }

  /** החלפת סוג של סופגנייה בתור. הצעדים שכבר נספרו לה נשארים ומקוזזים לפי הגודל החדש */
  changeType(index: number, type: DonutType): void {
    const need = stepsFor(type, this.kcalPerStep);
    let list = this.eaten().map((d, i) => (i === index ? { ...d, typeId: type.id, credited: Math.min(d.credited, need) } : d));
    const overflow = this.eaten()[index].credited - need;
    if (overflow > 0) {
      // הסוג החדש קטן יותר והצעדים כבר כיסו אותו – העודף ממשיך לבאה בתור או לבנק
      const r = distribute(list, null, overflow, this.kcalPerStep);
      list = r.eaten;
      this.bank.update((b) => b + r.rest);
      this.focus.set(null);
    }
    this.eaten.set(list);
    this.save();
  }

  /** בחירת הסופגנייה שתקבל את הצעדים מעכשיו. מה שכבר נספר לכל אחת נשמר לה */
  showInDashboard(index: number | null): void {
    this.focus.set(index);
    this.save();
  }

  reset(): void {
    this.stopSimulation();
    this.trackingStart = Date.now();
    this.baseSteps = 0;
    this.liveOffset = this.lastLive;
    this.steps.set(0);
    this.eaten.set([]);
    this.bank.set(0);
    this.focus.set(null);
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
      this.setTotalSteps(this.steps() + 30 + Math.floor(Math.random() * 16));
    }, 200);
  }

  /** קיצור דרך לבדיקות ולדמו */
  addSteps(n: number): void {
    this.baseSteps += n;
    this.setTotalSteps(this.steps() + n);
  }

  /** מעדכן את סך הצעדים, ומחלק את ההפרש לסופגנייה הפעילה / לתור / לבנק */
  private setTotalSteps(total: number): void {
    const delta = total - this.steps();
    this.steps.set(total);
    if (delta > 0) {
      const r = distribute(this.eaten(), this.focus(), delta, this.kcalPerStep);
      this.eaten.set(r.eaten);
      if (r.rest > 0) this.bank.update((b) => b + r.rest);
      const f = this.focus();
      if (f !== null && this.status().current?.index !== f) this.focus.set(null);
    }
    this.save();
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
        this.setTotalSteps(this.baseSteps + this.lastLive - this.liveOffset);
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

  /** באייפון: שולף מהמערכת את כל הצעדים מאז תחילת המעקב (גם כשהאפליקציה הייתה סגורה) */
  private async syncBaseFromSystem(): Promise<void> {
    if (this.isIos && this.trackingStart > 0) {
      try {
        const m = await CapacitorPedometer.getMeasurement({ start: this.trackingStart, end: Date.now() });
        // צעדים שנעשו כשהאפליקציה הייתה סגורה הולכים לסופגנייה הפעילה.
        // לא יורדים מתחת למה שכבר נספר (למשל מגבלת 7 הימים של iOS)
        this.setTotalSteps(Math.max(this.steps(), m.numberOfSteps ?? 0));
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
    if (this.sensor() === 'denied' || this.sensor() === 'needs-permission') {
      const perm = await CapacitorPedometer.checkPermissions();
      if (perm.activityRecognition === 'granted') await this.startLive();
    }
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
      this.eaten.set((saved.eaten ?? []).map((d) => ({ ...d, credited: d.credited ?? 0 })));
      this.steps.set(saved.steps ?? 0);
      this.bank.set(saved.bank ?? 0);
      this.focus.set(saved.focus ?? null);
      this.trackingStart = saved.trackingStart ?? 0;
    } catch {
      /* נתונים פגומים – מתחילים מחדש */
    }
  }

  private save(): void {
    const state: SavedState = {
      eaten: this.eaten(),
      steps: this.steps(),
      bank: this.bank(),
      focus: this.focus(),
      trackingStart: this.trackingStart,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* אחסון לא זמין */
    }
  }
}
