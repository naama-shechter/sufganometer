import { Injectable, NgZone, computed, effect, inject, signal, untracked } from '@angular/core';
import { Capacitor, PluginListenerHandle, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { CapacitorPedometer } from '@capgo/capacitor-pedometer';
import { BurnStatus, DonutType, EatenDonut, computeStatus, distribute, eatenFields, stepsFor } from './donut-calc';

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
  /** צעדים שהוזנו ידנית (לא מהחיישן) */
  manual?: number;
  /** Android: הערך הגולמי האחרון של מונה הצעדים, וזמן האתחול שאליו הוא שייך */
  lastRaw?: number | null;
  lastBoot?: number;
}

// אותו מפתח כמו קודם – השדות החדשים אופציונליים, כך שהנתונים הקיימים נשמרים
const STORAGE_KEY = 'sufganometer.v3';

/** תוסף מקומי (android/.../StepSensorPlugin.java): מונה הצעדים הגולמי מאז האתחול */
interface StepReading {
  count: number;
  bootTime: number;
}
interface StepSensorPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  getCount(): Promise<StepReading>;
  start(): Promise<void>;
  stop(): Promise<void>;
  addListener(event: 'count', fn: (r: StepReading) => void): Promise<PluginListenerHandle>;
  /** שירות חזית: ממשיך לספור ברקע ומציג בהתראה כמה צעדים נשארו */
  track(opts: { name: string; remaining: number; total: number }): Promise<void>;
  stopTracking(): Promise<void>;
  requestPermissions(opts: { permissions: 'notifications'[] }): Promise<{ notifications: string }>;
}
const StepSensor = registerPlugin<StepSensorPlugin>('StepSensor');

/** הפרש זמן אתחול שמעליו מניחים שהטלפון הופעל מחדש (המונה התאפס) */
const REBOOT_TOLERANCE_MS = 2 * 60 * 1000;

/**
 * מחבר את מד הצעדים המובנה של הטלפון (iOS: CMPedometer, Android: TYPE_STEP_COUNTER)
 * וסופר צעדים מאז תחילת המעקב. כל צעד חדש הולך לסופגנייה הפעילה (זו שמוצגת בדשבורד),
 * לכל סופגנייה נשמר מה שכבר נספר לה, ומה שנשאר אחרי כולן נשמר בבנק לסופגנייה הבאה.
 *
 * iOS  – בכל חזרה לאפליקציה שולפים מהמערכת את כל הצעדים מאז תחילת המעקב
 *        (עד 7 ימים אחורה), כולל כשהאפליקציה הייתה סגורה.
 * Android – כשיש סופגנייה בתור, שירות חזית (עם התראה) מחזיק את חיישן הצעדים פעיל גם ברקע.
 *           בכל חזרה לאפליקציה מוסיפים את הפרש מונה החומרה מאז הקריאה הקודמת.
 */
@Injectable({ providedIn: 'root' })
export class PedometerService {
  private readonly zone = inject(NgZone);

  readonly kcalPerStep = 0.04;
  readonly isNative = Capacitor.isNativePlatform();
  readonly isIos = Capacitor.getPlatform() === 'ios';
  readonly isAndroid = Capacitor.getPlatform() === 'android';

  readonly sensor = signal<SensorState>('checking');
  /** סך הצעדים שנספרו מאז תחילת המעקב (לתצוגה ולסנכרון מול החיישן) */
  readonly steps = signal(0);
  readonly eaten = signal<EatenDonut[]>([]);
  /** צעדים שלא שויכו לאף סופגנייה */
  readonly bank = signal(0);
  /** צעדים שהוזנו ידנית */
  readonly manual = signal(0);
  /** כל הצעדים שנספרו – מהחיישן ומהזנה ידנית */
  readonly countedSteps = computed(() => this.steps() + this.manual());
  /** איזו סופגנייה מהתור נבחרה לשריפה (null = הראשונה שעוד לא נשרפה) */
  readonly focus = signal<number | null>(null);
  readonly simulating = signal(false);

  readonly status = computed(() => computeStatus(this.eaten(), this.bank(), this.kcalPerStep, this.focus()));

  private trackingStart = 0;
  private baseSteps = 0;
  private lastLive = 0;
  private liveOffset = 0;
  private measurementListener?: PluginListenerHandle;
  private rawListener?: PluginListenerHandle;
  private lastRaw: number | null = null;
  private lastBoot = 0;

  private wantLive = false;
  private initialized = false;
  private simTimer?: ReturnType<typeof setInterval>;
  private trackingOn = false;
  private lastTracked?: { name: string; remaining: number; total: number };
  private notifAsked = false;

  constructor() {
    // Android: התראת "סופר צעדים" (שירות חזית) רק כשיש סופגנייה בתור
    effect(() => {
      const st = this.status();
      const live = this.sensor() === 'live';
      untracked(() => this.syncTracking(live ? st : null));
    });
  }

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
    this.eaten.update((list) => [...list, { ...eatenFields(type), at: Date.now(), credited: fromBank }]);
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
    let list = this.eaten().map((d, i) => (i === index ? { ...d, ...eatenFields(type), credited: Math.min(d.credited, need) } : d));
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
    this.manual.set(0);
    this.eaten.set([]);
    this.bank.set(0);
    this.focus.set(null);
    this.save();
  }

  /** הזנה ידנית של צעדים: הולכים לסופגנייה הפעילה, עודף לבאות בתור ואז לבנק */
  addManualSteps(n: number): void {
    const amount = Math.max(0, Math.round(n));
    if (!amount) return;
    this.manual.update((m) => m + amount);
    this.applySteps(amount);
  }

  /** מחיקת סופגנייה מהתור. הצעדים שנספרו לה עוברים לבאה בתור, או לבנק */
  removeDonut(index: number): void {
    const list = this.eaten();
    if (index < 0 || index >= list.length) return;
    const freed = list[index].credited;
    const rest = list.filter((_, i) => i !== index);
    const f = this.focus();
    const focus = f === null || f === index ? null : f > index ? f - 1 : f;
    const r = distribute(rest, focus, freed, this.kcalPerStep);
    this.eaten.set(r.eaten);
    this.focus.set(focus);
    if (r.rest > 0) this.bank.update((b) => b + r.rest);
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
      this.applySteps(delta);
    } else {
      this.save();
    }
  }

  /** מחלק צעדים חדשים לסופגנייה הפעילה / לתור / לבנק */
  private applySteps(amount: number): void {
    const r = distribute(this.eaten(), this.focus(), amount, this.kcalPerStep);
    this.eaten.set(r.eaten);
    if (r.rest > 0) this.bank.update((b) => b + r.rest);
    const f = this.focus();
    if (f !== null && this.status().current?.index !== f) this.focus.set(null);
    this.save();
  }

  // ---------- חיישן ----------

  private async startLive(): Promise<void> {
    this.wantLive = true;
    await this.stopLiveUpdates();

    if (this.isAndroid) {
      await this.startAndroidCounter();
      this.sensor.set('live');
      return;
    }

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
    if (this.isAndroid) {
      try {
        await StepSensor.stop();
      } catch {
        /* לא היה סשן פעיל */
      }
      await this.rawListener?.remove();
      this.rawListener = undefined;
      return;
    }
    try {
      await CapacitorPedometer.stopMeasurementUpdates();
    } catch {
      /* לא היה סשן פעיל */
    }
    await this.measurementListener?.remove();
    this.measurementListener = undefined;
  }

  /** Android: קריאה אחת להשלמת צעדים מהרקע, ואז עדכונים חיים כל עוד האפליקציה פתוחה */
  private async startAndroidCounter(): Promise<void> {
    // השלמת צעדים מהתקופה שבה האפליקציה הייתה ברקע
    try {
      this.applyRaw(await StepSensor.getCount());
    } catch (err) {
      console.warn('[Sufganometer] could not read step counter for catch-up', err);
    }

    this.rawListener = await StepSensor.addListener('count', (r) => this.zone.run(() => this.applyRaw(r)));
    await StepSensor.start();
  }

  /** מוסיף את ההפרש מאז הקריאה הקודמת של מונה החומרה (בזמן שהאפליקציה פתוחה) */
  private applyRaw(r: StepReading): void {
    const delta = this.consumeRaw(r);
    if (delta > 0) {
      this.setTotalSteps(this.steps() + delta);
    } else {
      this.save();
    }
  }

  /** מחשב את ההפרש מאז הקריאה הקודמת של מונה החומרה ומעדכן את נקודת הייחוס */
  private consumeRaw(r: StepReading): number {
    const count = Math.max(0, Math.round(r.count));
    const rebooted = this.lastBoot > 0 && Math.abs(r.bootTime - this.lastBoot) > REBOOT_TOLERANCE_MS;
    let delta = 0;
    if (this.lastRaw === null) {
      delta = 0; // קריאה ראשונה אי פעם – רק קובעים נקודת התחלה
    } else if (rebooted || count < this.lastRaw) {
      delta = count; // הטלפון הופעל מחדש והמונה התאפס: סופרים מה שנצבר מאז
    } else {
      delta = count - this.lastRaw;
    }
    this.lastRaw = count;
    this.lastBoot = r.bootTime;
    return delta;
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
    // לפני היציאה לרקע – לוודא שההתראה מעודכנת במצב האחרון
    if (this.sensor() === 'live') this.syncTracking(this.status(), true);
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

  /** מפעיל / מעדכן / עוצר את שירות הספירה ברקע לפי מצב התור */
  private syncTracking(st: BurnStatus | null, force = false): void {
    if (!this.isAndroid) return;
    const cur = st?.current;
    if (!st || !st.hasDebt || !cur) {
      if (this.trackingOn) {
        this.trackingOn = false;
        this.lastTracked = undefined;
        void StepSensor.stopTracking().catch(() => undefined);
      }
      return;
    }
    const payload = { name: cur.type.name, remaining: cur.left, total: st.stepsLeftTotal };
    const last = this.lastTracked;
    const changed =
      force || !this.trackingOn || !last || last.name !== payload.name || Math.abs(last.total - payload.total) >= 25;
    if (!changed) return;
    this.lastTracked = payload;
    this.trackingOn = true;
    void this.askNotificationsOnce()
      .then(() => StepSensor.track(payload))
      .catch((err) => {
        console.warn('[Sufganometer] background tracking not started', err);
        this.trackingOn = false;
      });
  }

  /** אנדרואיד 13+: הרשאת התראות, פעם אחת. גם אם סירבו – הספירה ברקע עדיין עובדת */
  private async askNotificationsOnce(): Promise<void> {
    if (this.notifAsked) return;
    this.notifAsked = true;
    try {
      await StepSensor.requestPermissions({ permissions: ['notifications'] });
    } catch {
      /* לא קריטי */
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
      this.manual.set(saved.manual ?? 0);
      this.lastRaw = saved.lastRaw ?? null;
      this.lastBoot = saved.lastBoot ?? 0;
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
      manual: this.manual(),
      lastRaw: this.lastRaw,
      lastBoot: this.lastBoot,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* אחסון לא זמין */
    }
  }
}
