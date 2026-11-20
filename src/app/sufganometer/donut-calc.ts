// חישובי "חוב הסופגניות" – לוגיקה טהורה, בלי תלות בחיישן או ב-Angular.
//
// המודל: יש סך צעדים שנספרו מאז תחילת המעקב, ורשימת סופגניות לפי סדר האכילה.
// הצעדים "משלמים" על הסופגניות לפי הסדר. מה שנשאר אחרי כולן הוא הבנק,
// וסופגנייה חדשה קודם כל מקוזזת ממנו.

export interface DonutType {
  id: string;
  name: string;
  /** הערכה גסה בלבד */
  kcal: number;
  topping: string;
}

export const DONUT_TYPES: DonutType[] = [
  { id: 'mini', name: 'מיני ריבה', kcal: 150, topping: '#C8102E' },
  { id: 'jam', name: 'סופגניית ריבה', kcal: 350, topping: '#C8102E' },
  { id: 'dulce', name: "דולצ'ה דה לצ'ה", kcal: 420, topping: '#B8732E' },
  { id: 'fancy', name: 'פרלינים', kcal: 480, topping: '#5A3418' },
];

export interface EatenDonut {
  typeId: string;
  at: number; // epoch ms
}

export interface DonutSlot {
  index: number;
  type: DonutType;
  need: number;
  done: number;
  left: number;
  burned: boolean;
  /** 0..1 */
  progress: number;
}

export interface BurnStatus {
  slots: DonutSlot[];
  /** הסופגנייה שנשרפת עכשיו (null אם אין חוב) */
  current: DonutSlot | null;
  /** הסופגנייה שמוצגת בדשבורד – הנוכחית או אחת שנבחרה מהתור */
  viewed: DonutSlot | null;
  noDonutsYet: boolean;
  hasDebt: boolean;
  done: boolean;
  bank: number;
  queue: number;
  totalNeed: number;
  stepsLeftTotal: number;
  /** כמה צעדים נשארו עד שהסופגנייה המוצגת תתחיל להישרף */
  stepsUntilViewedStarts: number;
  message: string;
  funFact: string;
}

const RING_START = [200, 16, 46]; // #C8102E – אדום ריבה
const RING_END = [184, 87, 27]; // #B8571B – כתום-חום, כמו "מותר לטגן"

export function typeById(id: string): DonutType {
  return DONUT_TYPES.find((t) => t.id === id) ?? DONUT_TYPES[1];
}

export function stepsFor(type: DonutType, kcalPerStep: number): number {
  return Math.round(type.kcal / kcalPerStep);
}

export function computeStatus(
  eaten: EatenDonut[],
  steps: number,
  kcalPerStep: number,
  focusIndex: number | null = null,
): BurnStatus {
  const slots: DonutSlot[] = [];
  let cum = 0;
  let current: DonutSlot | null = null;

  eaten.forEach((d, index) => {
    const type = typeById(d.typeId);
    const need = stepsFor(type, kcalPerStep);
    const done = Math.min(need, Math.max(0, steps - cum));
    const slot: DonutSlot = { index, type, need, done, left: need - done, burned: done >= need, progress: done / need };
    slots.push(slot);
    if (!current && !slot.burned) current = slot;
    cum += need;
  });

  const cur = current as DonutSlot | null;
  const focused = focusIndex !== null ? slots[focusIndex] : undefined;
  const viewed = cur ? (focused && !focused.burned ? focused : cur) : null;
  const noDonutsYet = eaten.length === 0;
  const hasDebt = !!cur;
  const done = !hasDebt && !noDonutsYet;
  const bank = hasDebt ? 0 : steps - cum;
  const queue = cur ? eaten.length - cur.index : 0;
  const stepsLeftTotal = Math.max(0, cum - steps);
  const stepsUntilViewedStarts =
    viewed && cur ? slots.slice(cur.index, viewed.index).reduce((sum, s) => sum + s.left, 0) : 0;

  const p = cur?.progress ?? 0;
  let message: string;
  if (noDonutsYet) message = 'עוד לא נכנסה סופגנייה. כל צעד נשמר בבנק.';
  else if (done) message = 'חוב הסופגניות נמחק! מעכשיו כל צעד נכנס לבנק.';
  else if (queue > 1) message = `יש לך ${queue} סופגניות בתור. זה כבר לא חטיף, זה פרויקט.`;
  else if (p < 0.25) message = 'הסופגנייה עדיין מרגישה בבית. קדימה, לזוז!';
  else if (p < 0.5) message = 'הריבה כבר מתחילה לארוז מזוודות.';
  else if (p < 0.75) message = 'חצי מאחוריך. אבקת הסוכר כבר מתפזרת ברוח.';
  else message = 'עוד קצת! כבר מריחים שמן חדש במטבח.';

  let funFact: string;
  if (hasDebt) {
    funFact = `≈ ${Math.ceil(stepsLeftTotal / 100)} דק׳ הליכה, או ${fmt(Math.ceil(stepsLeftTotal / 15))} הליכות מהסלון למקרר (בלי לפתוח אותו).`;
  } else {
    const share = bank / stepsFor(typeById('jam'), kcalPerStep);
    funFact =
      share >= 1
        ? 'בבנק יש מספיק לסופגניית ריבה שלמה על חשבון הבית.'
        : `הבנק מכסה כבר ${Math.round(share * 100)}% מסופגניית ריבה.`;
  }

  return {
    slots,
    current: cur,
    viewed,
    noDonutsYet,
    hasDebt,
    done,
    bank,
    queue,
    totalNeed: cum,
    stepsLeftTotal,
    stepsUntilViewedStarts,
    message,
    funFact,
  };
}

/** צבע הטבעת בנקודה t (0..1): מאדום ריבה לכתום-חום */
export function ringColor(t: number): string {
  const c = RING_START.map((a, i) => Math.round(a + (RING_END[i] - a) * Math.min(1, Math.max(0, t))));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/**
 * צבעי שני הקצוות של הטבעת בהתקדמות p.
 * ככל שמתקרבים לסגירה גם תחילת הטבעת מתחממת, כך שהחיבור בין הקצוות זורם בלי תפר.
 */
export function ringEnds(p: number): { start: string; end: string } {
  return { start: ringColor(Math.max(0, (p - 0.6) / 0.4)), end: ringColor(p) };
}

export function fmt(n: number): string {
  return Math.max(0, Math.round(n)).toLocaleString('he-IL');
}
