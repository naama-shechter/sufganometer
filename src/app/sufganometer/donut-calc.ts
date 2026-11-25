// חישובי "חוב הסופגניות" – לוגיקה טהורה, בלי תלות בחיישן או ב-Angular.
//
// המודל: לכל סופגנייה נשמר כמה צעדים כבר נספרו לה (credited).
// צעדים חדשים הולכים לסופגנייה הפעילה – זו שנבחרה בתור ומוצגת בדשבורד, ואם לא נבחרה אחת,
// הראשונה שעוד לא נשרפה. כשהיא נשרפת, העודף ממשיך לבאה בתור, ומה שנשאר אחרי כולן נכנס לבנק.
// סופגנייה חדשה קודם כל מקוזזת מהבנק.

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
  /** צעדים שכבר נספרו לסופגנייה הזו */
  credited: number;
  /** סופגנייה אחרת שהמשתמש בנה בעצמו (typeId === 'custom') */
  custom?: { name: string; kcal: number; topping: string };
}

// ---------- "סופגנייה אחרת": הערכת קלוריות לפי גודל, מילוי וציפוי (הערכה גסה בלבד) ----------

export interface CustomOption {
  id: string;
  label: string;
  /** תוספת קלוריות לסופגנייה בגודל רגיל */
  kcal: number;
  /** צבע הציפוי באייקון */
  color?: string;
  /** איך זה נשמע בשם: "סופגניית ___" */
  word?: string;
}

export const CUSTOM_SIZES: (CustomOption & { mult: number })[] = [
  { id: 'mini', label: 'מיני', kcal: 0, mult: 0.45 },
  { id: 'regular', label: 'רגילה', kcal: 0, mult: 1 },
  { id: 'large', label: 'ענקית', kcal: 0, mult: 1.6 },
];

export const CUSTOM_FILLINGS: CustomOption[] = [
  { id: 'none', label: 'בלי מילוי', kcal: 0 },
  { id: 'jam', label: 'ריבה', kcal: 70, color: '#C8102E', word: 'ריבה' },
  { id: 'cream', label: 'קרם וניל', kcal: 90, color: '#F3E3B5', word: 'קרם' },
  { id: 'choc', label: 'שוקולד', kcal: 130, color: '#5A3418', word: 'שוקולד' },
  { id: 'dulce', label: 'ריבת חלב', kcal: 140, color: '#B8732E', word: "דולצ'ה" },
  { id: 'pistachio', label: 'פיסטוק', kcal: 160, color: '#8DB255', word: 'פיסטוק' },
  { id: 'lotus', label: 'לוטוס', kcal: 150, color: '#A0642F', word: 'לוטוס' },
];

export const CUSTOM_TOPPINGS: CustomOption[] = [
  { id: 'sugar', label: 'אבקת סוכר', kcal: 15 },
  { id: 'glaze', label: 'זיגוג', kcal: 60, color: '#F6C9D6', word: 'עם זיגוג' },
  { id: 'choc', label: 'ציפוי שוקולד', kcal: 90, color: '#5A3418', word: 'עם ציפוי שוקולד' },
  { id: 'deco', label: 'קרם וקישוטים', kcal: 130, color: '#E8546B', word: 'עם קרם וקישוטים' },
];

/** בצק מטוגן בגודל רגיל, בלי מילוי וציפוי */
const CUSTOM_BASE_KCAL = 250;

export interface CustomChoice {
  size: string;
  filling: string;
  topping: string;
  /** הזנה מדויקת (למשל מהתווית). אם קיים – גובר על ההערכה */
  exactKcal?: number | null;
  name?: string;
}

/** הופך בחירות של "סופגנייה אחרת" לסוג סופגנייה עם הערכת קלוריות, שם וצבע */
export function buildCustomType(c: CustomChoice): DonutType {
  const size = CUSTOM_SIZES.find((x) => x.id === c.size) ?? CUSTOM_SIZES[1];
  const filling = CUSTOM_FILLINGS.find((x) => x.id === c.filling) ?? CUSTOM_FILLINGS[0];
  const topping = CUSTOM_TOPPINGS.find((x) => x.id === c.topping) ?? CUSTOM_TOPPINGS[0];
  const estimate = Math.round(((CUSTOM_BASE_KCAL + filling.kcal + topping.kcal) * size.mult) / 10) * 10;
  const kcal = c.exactKcal && c.exactKcal > 0 ? Math.round(c.exactKcal) : estimate;

  let auto = filling.word ? 'סופגניית ' + filling.word : 'סופגנייה ' + (topping.word ?? 'עם אבקת סוכר');
  if (size.id === 'mini') auto += ' (מיני)';
  if (size.id === 'large') auto += ' (ענקית)';
  const name = (c.name ?? '').trim().slice(0, 30) || auto;

  // צבע הציפוי באייקון: ציפוי בולט קודם, אחר כך המילוי, ובלי שניהם – אבקת סוכר לבנה
  const color = (topping.id !== 'sugar' ? topping.color : undefined) ?? filling.color ?? '#FFF8EC';
  return { id: 'custom', name, kcal, topping: color };
}

/** הסוג של סופגנייה שנאכלה – מהרשימה הקבועה, או "סופגנייה אחרת" */
export function typeOf(d: EatenDonut): DonutType {
  return d.custom ? { id: 'custom', ...d.custom } : typeById(d.typeId);
}

/** רשומת סופגנייה לשמירה מסוג נתון */
export function eatenFields(type: DonutType): Pick<EatenDonut, 'typeId' | 'custom'> {
  return type.id === 'custom'
    ? { typeId: 'custom', custom: { name: type.name, kcal: type.kcal, topping: type.topping } }
    : { typeId: type.id, custom: undefined };
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

/** הסופגנייה שמקבלת צעדים: זו שנבחרה (אם עוד לא נשרפה), אחרת הראשונה שלא נשרפה. -1 אם אין */
export function activeIndex(eaten: EatenDonut[], focus: number | null, kcalPerStep: number): number {
  const open = (d: EatenDonut) => d.credited < stepsFor(typeOf(d), kcalPerStep);
  if (focus !== null && focus < eaten.length && open(eaten[focus])) return focus;
  return eaten.findIndex(open);
}

/** מחלק צעדים חדשים: לסופגנייה הפעילה, עודף לבאות בתור, ומה שנשאר – rest (לבנק) */
export function distribute(
  eaten: EatenDonut[],
  focus: number | null,
  amount: number,
  kcalPerStep: number,
): { eaten: EatenDonut[]; rest: number } {
  const list = eaten.map((d) => ({ ...d }));
  let rest = amount;
  while (rest > 0) {
    const a = activeIndex(list, focus, kcalPerStep);
    if (a < 0) break;
    const take = Math.min(rest, stepsFor(typeOf(list[a]), kcalPerStep) - list[a].credited);
    list[a].credited += take;
    rest -= take;
  }
  return { eaten: list, rest };
}

export function computeStatus(
  eaten: EatenDonut[],
  bank: number,
  kcalPerStep: number,
  focusIndex: number | null = null,
): BurnStatus {
  const slots: DonutSlot[] = eaten.map((d, index) => {
    const type = typeOf(d);
    const need = stepsFor(type, kcalPerStep);
    const done = Math.min(need, Math.max(0, d.credited ?? 0));
    return { index, type, need, done, left: need - done, burned: done >= need, progress: done / need };
  });

  const ai = activeIndex(eaten, focusIndex, kcalPerStep);
  const cur = ai >= 0 ? slots[ai] : null;
  const viewed = cur;
  const noDonutsYet = eaten.length === 0;
  const hasDebt = !!cur;
  const done = !hasDebt && !noDonutsYet;
  const queue = slots.filter((s) => !s.burned).length;
  const cum = slots.reduce((sum, s) => sum + s.need, 0);
  const stepsLeftTotal = slots.reduce((sum, s) => sum + s.left, 0);
  const stepsUntilViewedStarts = 0;

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
 * גרדיאנט קבוע לאורך העיגול: תמיד מתחיל באדום, והקצה המתקדם מקבל את הצבע של המיקום שלו.
 */
export function ringEnds(p: number): { start: string; end: string } {
  return { start: ringColor(0), end: ringColor(p) };
}

/** "ה" + שם: "סופגניית ריבה" ← "סופגניית הריבה", אחרת "ה" + השם */
export function theName(name: string): string {
  if (name.startsWith('סופגניית ')) return 'סופגניית ה' + name.slice(9);
  if (name.startsWith('ה')) return name; // שם שהמשתמש כתב וכבר מיודע ("הפיסטוק מהמאפייה")
  return 'ה' + name;
}

export function fmt(n: number): string {
  return Math.max(0, Math.round(n)).toLocaleString('he-IL');
}
