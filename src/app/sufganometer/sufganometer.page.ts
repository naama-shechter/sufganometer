import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { IonContent } from '@ionic/angular/standalone';
import { App } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { PedometerService, SensorState, BankOutcome } from './pedometer.service';
import { DONUT_TYPES, DonutType, fmt, ringColor, stepsFor, theName } from './donut-calc';

type SheetMode = 'add' | 'change' | 'queue' | null;

interface Notice {
  title: string;
  body: string;
  gold: boolean;
}

const SENSOR_LABELS: Record<SensorState, string> = {
  checking: 'בודק חיישן…',
  'needs-permission': 'לא מחובר',
  denied: 'אין הרשאה',
  unsupported: 'אין חיישן צעדים',
  live: 'מחובר למד הצעדים',
  web: 'דפדפן · הדמיה',
  error: 'שגיאה בחיישן',
};

const MOODS = ['מאושרת', 'שמחה', 'מתונה', 'עצובה', 'עצבנית', 'רותחת מזעם'];

function blend(from: string, to: string, t: number): string {
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = rgb(from);
  const b = rgb(to);
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(', ')})`;
}

const CONFETTI_COLORS = ['#C8102E', '#F2C14E', '#3B2311', '#1F7A4D', '#E8546B', '#F0B56C', '#2F6FDE'];

@Component({
  selector: 'app-sufganometer',
  standalone: true,
  imports: [IonContent],
  templateUrl: './sufganometer.page.html',
  styleUrls: ['./sufganometer.page.scss'],
})
export class SufganometerPage implements OnInit, OnDestroy {
  readonly pedo = inject(PedometerService);
  readonly types = DONUT_TYPES;
  readonly fmt = fmt;
  readonly theName = theName;

  readonly s = this.pedo.status;

  // ---------- חלונות ----------
  readonly sheet = signal<SheetMode>(null);
  readonly pending = signal<DonutType | null>(null);
  readonly notice = signal<Notice | null>(null);
  readonly resetAsk = signal(false);

  // ---------- הזנה ידנית ----------
  readonly manualOpen = signal(false);
  readonly manualSteps = signal(0);
  readonly manualOath = signal(false);
  readonly canAddManual = computed(() => this.manualOath() && this.manualSteps() > 0 && this.manualSteps() <= 50000);

  // ---------- מחיקה מהתור ----------
  readonly deleteIndex = signal<number | null>(null);
  readonly deleteTarget = computed(() => {
    const i = this.deleteIndex();
    return i === null ? null : (this.s().slots[i] ?? null);
  });

  // ---------- חגיגה ----------
  /** משתנה בכל כניסה מחדש למסך כדי להריץ שוב את החגיגה. הדעיכה אחרי כ-4 שניות היא ב-CSS */
  readonly sceneKey = signal(0);
  private resumeListener?: PluginListenerHandle;

  // ---------- ספירת פתיחה: המספרים והטבעת עולים מאפס בכל כניסה למסך ----------
  readonly intro = signal(0);
  readonly introEase = computed(() => 1 - Math.pow(1 - this.intro(), 3));
  readonly introDone = computed(() => this.intro() >= 1);
  private introRaf?: number;

  readonly confetti = Array.from({ length: 30 }, (_, c) => {
    const w = 7 + (c % 3) * 2;
    const h = 12 - (c % 3) * 2;
    return [
      `left: ${(c * 37 + 5) % 100}%`,
      `width: ${w}px`,
      `height: ${h}px`,
      `background: ${CONFETTI_COLORS[c % CONFETTI_COLORS.length]}`,
      `border-radius: ${c % 4 === 0 ? '50%' : '2px'}`,
      `--r: ${(c % 2 ? 1 : -1) * (360 + c * 24)}deg`,
      `animation-duration: ${(2.6 + (c % 5) * 0.35).toFixed(2)}s`,
      `animation-delay: -${((c * 0.23) % 3).toFixed(2)}s`,
    ].join('; ');
  });

  readonly pans = [10, 36, 62, 84].map((left, j) =>
    [
      `left: ${left}%`,
      `--dx: ${j % 2 ? 50 : -50}px`,
      `--r: ${j % 2 ? 540 : -540}deg`,
      `animation-duration: ${(3.4 + j * 0.3).toFixed(1)}s`,
      `animation-delay: -${(j * 0.9).toFixed(1)}s`,
    ].join('; '),
  );

  readonly splash = [-90, -60, -30, -8, 12, 34, 64, 92].map((dx, j) =>
    [`--dx: ${dx}px`, `--dy: ${-70 - (j % 3) * 25}px`, `animation-delay: ${(j * 0.12).toFixed(2)}s`].join('; '),
  );

  // ---------- תצוגה ----------
  readonly sensorLabel = computed(() => SENSOR_LABELS[this.pedo.sensor()]);
  readonly showConnect = computed(() => ['needs-permission', 'denied'].includes(this.pedo.sensor()));
  readonly lastType = computed(() => {
    const list = this.pedo.eaten();
    return list.length ? (DONUT_TYPES.find((t) => t.id === list[list.length - 1].typeId) ?? DONUT_TYPES[1]) : DONUT_TYPES[1];
  });

  readonly progress = computed(() => this.s().viewed?.progress ?? 0);
  /** 0 מאושרת · 1 שמחה · 2 מתונה · 3 עצובה · 4 עצבנית · 5 רותחת מזעם */
  readonly mood = computed(() => (this.s().viewed ? Math.min(5, Math.floor(this.progress() * 6)) : 0));
  /** הבצק מאדים בהדרגה, כאילו הסופגנייה מתחממת מעצבים */
  readonly dough = computed(() => {
    const h = this.s().viewed ? this.progress() : 0;
    return {
      dark: blend('#B8692A', '#9E2A18', h),
      mid: blend('#E39A4B', '#D84A2E', h),
      light: blend('#F0B56C', '#EE7E5A', h),
    };
  });
  /** עשן מהאוזניים */
  readonly steam = [-1, 1].flatMap((side) =>
    [0, 1, 2].map((j) => ({ x: side * (80 + j * 3), y: -2 - j * 6, r: 7 + j * 2, delay: `${(j * 0.45).toFixed(2)}s` })),
  );
  readonly ringLabel = computed(() => {
    const v = this.s().viewed;
    return v ? `נשרפו ${Math.round(v.progress * 100)} אחוז מ${theName(v.type.name)}. מצב רוח: ${MOODS[this.mood()]}` : 'אין סופגנייה פתוחה';
  });

  readonly viewKicker = computed(() => {
    const st = this.s();
    const v = st.viewed;
    if (!v) return '';
    const pos = st.slots.filter((x) => !x.burned && x.index <= v.index).length;
    return st.queue > 1 ? `עכשיו שורפים · ${pos} מתוך ${st.queue}` : 'עכשיו שורפים';
  });
  readonly viewLine = computed(() => {
    const v = this.s().viewed;
    return v ? `נשארו ${fmt(this.count(v.left))} צעדים לסופגנייה הזו` : '';
  });
  readonly queueLabel = computed(() => {
    const q = Math.round(this.s().queue * this.introEase());
    return q === 1 ? 'סופגנייה 1' : `${q} סופגניות`;
  });
  /** הטבעת כפי שמוצגת – עולה מאפס יחד עם ספירת הפתיחה */
  readonly ringShown = computed(() => this.progress() * this.introEase());

  /** התור מהחדשה לישנה */
  readonly queueItems = computed(() => {
    const st = this.s();
    return [...st.slots].reverse().map((slot) => ({
      slot,
      isViewed: !slot.burned && slot.index === st.viewed?.index,
      status: slot.burned
        ? 'נשרפה'
        : slot.index === st.current?.index
          ? `נשרפת עכשיו · ${Math.round(slot.progress * 100)}%`
          : slot.done > 0
            ? `מושהית · ${Math.round(slot.progress * 100)}%`
            : `מחכה · ${fmt(slot.need)} צעדים`,
      bar: `linear-gradient(90deg, #C8102E, ${ringColor(slot.progress)})`,
    }));
  });

  readonly sheetTitle = computed(() =>
    this.sheet() === 'change' ? 'לאיזו סופגנייה להחליף?' : this.sheet() === 'queue' ? 'הסופגניות בתור' : 'איזו סופגנייה נכנסה?',
  );
  readonly sheetSub = computed(() => {
    if (this.sheet() === 'change') return 'הצעדים שכבר נספרו לה יישארו, ויקוזזו לפי הגודל החדש';
    if (this.sheet() === 'queue') return 'בחרו איזו סופגנייה לשרוף עכשיו. מה שכבר נספר לכל אחת נשמר לה.';
    const bank = this.s().bank;
    return bank > 0 ? `יש ${fmt(bank)} צעדים בבנק שיקוזזו ממנה` : 'בחרו סוג, ונתחיל לשרוף';
  });

  ngOnInit(): void {
    void this.pedo.init();
    this.playIntro();
    void App.addListener('resume', () => {
      this.playIntro();
      this.replayIfDone();
    }).then((h) => (this.resumeListener = h));
  }

  /** Ionic: בכל כניסה מחדש למסך */
  ionViewWillEnter(): void {
    this.playIntro();
  }

  ionViewDidEnter(): void {
    this.replayIfDone();
  }

  ngOnDestroy(): void {
    if (this.introRaf) cancelAnimationFrame(this.introRaf);
    void this.resumeListener?.remove();
  }

  /** ערך מספרי כפי שמוצג בזמן ספירת הפתיחה */
  count(n: number): number {
    return n * this.introEase();
  }

  private playIntro(duration = 1200): void {
    if (this.introRaf) cancelAnimationFrame(this.introRaf);
    this.intro.set(0);
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      this.intro.set(t);
      this.introRaf = t < 1 ? requestAnimationFrame(step) : undefined;
    };
    this.introRaf = requestAnimationFrame(step);
  }

  stepsFor(type: DonutType): string {
    return fmt(stepsFor(type, this.pedo.kcalPerStep));
  }

  // ---------- פעולות ----------

  openSheet(mode: SheetMode): void {
    this.sheet.set(mode);
  }

  closeSheet(): void {
    this.sheet.set(null);
  }

  pickType(type: DonutType): void {
    if (this.sheet() === 'add') {
      this.addDonut(type);
      return;
    }
    const viewed = this.s().viewed;
    this.sheet.set(null);
    if (!viewed || viewed.type.id === type.id) return;
    this.pending.set(type);
  }

  showInDashboard(index: number, burned: boolean): void {
    if (burned) return;
    this.pedo.showInDashboard(index);
    this.sheet.set(null);
  }

  confirmChange(): void {
    const viewed = this.s().viewed;
    const type = this.pending();
    this.pending.set(null);
    if (!viewed || !type) return;

    const newNeed = stepsFor(type, this.pedo.kcalPerStep);
    this.pedo.changeType(viewed.index, type);

    if (viewed.done === 0) {
      this.notice.set({ title: 'הוחלף!', body: `${theName(type.name)} מחכה בתור, ותצטרך ${fmt(newNeed)} צעדים.`, gold: false });
    } else if (viewed.done >= newNeed) {
      this.notice.set({
        title: 'הוחלף, וכבר נשרפה!',
        body: `עם ${fmt(viewed.done)} הצעדים שכבר עשית, ${theName(type.name)} מכוסה לגמרי.`,
        gold: true,
      });
    } else {
      this.notice.set({
        title: 'הוחלף!',
        body: `הצעדים שכבר עשית (${fmt(viewed.done)}) קוזזו לפי ${theName(type.name)}. נשארו ${fmt(newNeed - viewed.done)} צעדים.`,
        gold: false,
      });
    }
  }

  /** "אופס… בעצם זו עוד אחת" */
  oopsAnother(): void {
    const type = this.pending();
    this.pending.set(null);
    if (type) this.addDonut(type);
  }

  cancelConfirm(): void {
    this.pending.set(null);
  }

  closeNotice(): void {
    this.notice.set(null);
  }

  openManual(): void {
    this.manualSteps.set(0);
    this.manualOath.set(false);
    this.manualOpen.set(true);
  }

  onManualInput(event: Event): void {
    const v = parseInt((event.target as HTMLInputElement).value, 10);
    this.manualSteps.set(Number.isFinite(v) && v > 0 ? Math.min(v, 50000) : 0);
  }

  addQuick(n: number): void {
    this.manualSteps.update((v) => Math.min(50000, v + n));
  }

  confirmManual(): void {
    if (!this.canAddManual()) return;
    const n = this.manualSteps();
    const target = this.s().viewed;
    this.pedo.addManualSteps(n);
    this.manualOpen.set(false);
    this.notice.set({
      title: 'נרשם!',
      body: target
        ? `${fmt(n)} צעדים ירדו מ${theName(target.type.name)}. הסופגנייה סומכת עליך.`
        : `${fmt(n)} צעדים נכנסו לבנק, ויקוזזו מהסופגנייה הבאה.`,
      gold: false,
    });
  }

  askDelete(index: number): void {
    this.deleteIndex.set(index);
  }

  confirmDelete(): void {
    const i = this.deleteIndex();
    this.deleteIndex.set(null);
    if (i !== null) this.pedo.removeDonut(i);
  }

  /** איפוס מלא: צעדים, סופגניות, בנק והדמיה – הכל לאפס */
  resetAll(): void {
    this.resetAsk.set(false);
    this.sheet.set(null);
    this.pending.set(null);
    this.notice.set(null);
    this.pedo.reset();
  }

  private addDonut(type: DonutType): void {
    this.sheet.set(null);
    const outcome: BankOutcome = this.pedo.eat(type);
    if (outcome.kind === 'free') {
      this.notice.set({
        title: 'על חשבון הבית!',
        body: `${theName(type.name)} כבר שולמה מראש: ${fmt(outcome.need)} צעדים ירדו מהבנק, ונשארו בו עוד ${fmt(outcome.bankLeft)}.`,
        gold: true,
      });
    } else if (outcome.kind === 'partial') {
      this.notice.set({
        title: 'קיזזנו מהבנק',
        body: `${fmt(outcome.used)} צעדים מהבנק כבר הלכו על ${theName(type.name)}. נשארו עוד ${fmt(outcome.left)} צעדים.`,
        gold: false,
      });
    }
  }

  private replayIfDone(): void {
    if (this.s().done) this.sceneKey.update((k) => k + 1);
  }
}
