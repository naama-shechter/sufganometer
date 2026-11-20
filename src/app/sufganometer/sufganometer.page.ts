import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { IonContent } from '@ionic/angular/standalone';
import { App } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { PedometerService, SensorState, BankOutcome } from './pedometer.service';
import { DONUT_TYPES, DonutType, fmt, ringColor, ringEnds, stepsFor } from './donut-calc';

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

const RING_R = 90; // רדיוס קו האמצע של הטבעת, בתוך קופסה של 210px

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

  readonly s = this.pedo.status;

  // ---------- חלונות ----------
  readonly sheet = signal<SheetMode>(null);
  readonly pending = signal<DonutType | null>(null);
  readonly notice = signal<Notice | null>(null);

  // ---------- חגיגה ----------
  /** משתנה בכל כניסה מחדש למסך כדי להריץ שוב את החגיגה. הדעיכה אחרי כ-4 שניות היא ב-CSS */
  readonly sceneKey = signal(0);
  private resumeListener?: PluginListenerHandle;

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
  readonly ring = computed(() => {
    const p = this.progress();
    const deg = Math.max(0, Math.min(360, p * 360));
    const { start, end } = ringEnds(p);
    const rad = (deg * Math.PI) / 180;
    return {
      background: `conic-gradient(from 0deg, ${start} 0deg, ${end} ${deg.toFixed(1)}deg, transparent ${deg.toFixed(1)}deg)`,
      capStartColor: start,
      capX: 105 + RING_R * Math.sin(rad) - 7.5,
      capY: 105 - RING_R * Math.cos(rad) - 7.5,
      capColor: end,
      showCaps: p > 0.005,
    };
  });
  readonly donutTransform = computed(() => `translate(130 136) scale(${Math.max(0.18, 1 - this.progress() * 0.82)})`);
  readonly mouthPath = computed(() => (this.progress() < 0.5 ? 'M-14 14 Q0 26 14 14' : 'M-14 20 Q0 10 14 20'));
  readonly ringLabel = computed(() => {
    const v = this.s().viewed;
    return v ? `נשרפו ${Math.round(v.progress * 100)} אחוז מה${v.type.name}` : 'אין סופגנייה פתוחה';
  });

  readonly viewKicker = computed(() => {
    const st = this.s();
    if (!st.viewed || !st.current) return '';
    if (st.viewed.index === st.current.index) {
      return st.queue > 1 ? `עכשיו שורפים · 1 מתוך ${st.queue}` : 'עכשיו שורפים';
    }
    return `בתצוגה · מקום ${st.viewed.index - st.current.index + 1} בתור`;
  });
  readonly viewLine = computed(() => {
    const st = this.s();
    if (!st.viewed || !st.current) return '';
    return st.viewed.index === st.current.index
      ? `נשארו ${fmt(st.viewed.left)} צעדים לסופגנייה הזו`
      : `תתחיל להישרף אחרי ${fmt(st.stepsUntilViewedStarts)} צעדים`;
  });
  readonly queueLabel = computed(() => (this.s().queue === 1 ? 'סופגנייה 1' : `${this.s().queue} סופגניות`));

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
          : `מחכה · ${fmt(slot.need)} צעדים`,
      bar: `linear-gradient(90deg, #C8102E, ${ringColor(slot.progress)})`,
    }));
  });

  readonly sheetTitle = computed(() =>
    this.sheet() === 'change' ? 'לאיזו סופגנייה להחליף?' : this.sheet() === 'queue' ? 'הסופגניות בתור' : 'איזו סופגנייה נכנסה?',
  );
  readonly sheetSub = computed(() => {
    if (this.sheet() === 'change') return 'הצעדים שכבר נספרו לה יישארו, ויקוזזו לפי הגודל החדש';
    if (this.sheet() === 'queue') return 'בחרו איזו סופגנייה להציג בדשבורד. השריפה עצמה הולכת לפי הסדר.';
    const bank = this.s().bank;
    return bank > 0 ? `יש ${fmt(bank)} צעדים בבנק שיקוזזו ממנה` : 'בחרו סוג, ונתחיל לשרוף';
  });

  ngOnInit(): void {
    void this.pedo.init();
    void App.addListener('resume', () => this.replayIfDone()).then((h) => (this.resumeListener = h));
  }

  /** Ionic: בכל כניסה מחדש למסך */
  ionViewDidEnter(): void {
    this.replayIfDone();
  }

  ngOnDestroy(): void {
    void this.resumeListener?.remove();
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
      this.notice.set({ title: 'הוחלף!', body: `ה${type.name} מחכה בתור, ותצטרך ${fmt(newNeed)} צעדים.`, gold: false });
    } else if (viewed.done >= newNeed) {
      this.notice.set({
        title: 'הוחלף, וכבר נשרפה!',
        body: `עם ${fmt(viewed.done)} הצעדים שכבר עשית, ה${type.name} מכוסה לגמרי.`,
        gold: true,
      });
    } else {
      this.notice.set({
        title: 'הוחלף!',
        body: `הצעדים שכבר עשית (${fmt(viewed.done)}) קוזזו לפי ה${type.name}. נשארו ${fmt(newNeed - viewed.done)} צעדים.`,
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

  private addDonut(type: DonutType): void {
    this.sheet.set(null);
    const outcome: BankOutcome = this.pedo.eat(type);
    if (outcome.kind === 'free') {
      this.notice.set({
        title: 'על חשבון הבית!',
        body: `ה${type.name} כבר שולמה מראש: ${fmt(outcome.need)} צעדים ירדו מהבנק, ונשארו בו עוד ${fmt(outcome.bankLeft)}.`,
        gold: true,
      });
    } else if (outcome.kind === 'partial') {
      this.notice.set({
        title: 'קיזזנו מהבנק',
        body: `${fmt(outcome.used)} צעדים מהבנק כבר הלכו על ה${type.name}. נשארו עוד ${fmt(outcome.left)} צעדים.`,
        gold: false,
      });
    }
  }

  private replayIfDone(): void {
    if (this.s().done) this.sceneKey.update((k) => k + 1);
  }
}
