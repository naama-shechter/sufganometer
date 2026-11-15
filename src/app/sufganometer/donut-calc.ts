// חישובי "חוב הסופגניות" – לוגיקה טהורה, בלי תלות בחיישן או ב-Angular.

export interface DonutType {
  id: string;
  label: string;
  /** הערכה גסה בלבד */
  kcal: number;
}

export const DONUT_TYPES: DonutType[] = [
  { id: 'mini', label: 'מיני', kcal: 150 },
  { id: 'jam', label: 'ריבה', kcal: 350 },
  { id: 'dulce', label: "דולצ'ה", kcal: 420 },
  { id: 'fancy', label: 'פרלינים', kcal: 480 },
];

export interface EatenDonut {
  typeId: string;
  kcal: number;
  at: number; // epoch ms
}

export interface BurnStatus {
  hasDebt: boolean;
  done: boolean;
  totalKcal: number;
  burnedKcal: number;
  remainingKcal: number;
  /** צעדים עד שמותר סופגנייה חדשה (כל החוב) */
  stepsLeftTotal: number;
  /** צעדים שנשארו לסופגנייה שנשרפת עכשיו */
  stepsLeftCurrent: number;
  /** 0..1 – התקדמות בסופגנייה הנוכחית */
  currentProgress: number;
  /** כמה סופגניות עוד לא נשרפו (כולל הנוכחית) */
  queue: number;
  minutesLeft: number;
  fridgeTrips: number;
  message: string;
  funFact: string;
}

export function computeStatus(eaten: EatenDonut[], steps: number, kcalPerStep: number): BurnStatus {
  const total = eaten.reduce((sum, d) => sum + d.kcal, 0);
  const burned = Math.max(0, steps) * kcalPerStep;
  const remaining = Math.max(0, total - burned);
  const hasDebt = eaten.length > 0;
  const done = !hasDebt || remaining <= 0;

  let cum = 0;
  let curIdx = eaten.length;
  let curProgress = 1;
  let curLeftKcal = 0;
  for (let i = 0; i < eaten.length; i++) {
    const kc = eaten[i].kcal;
    if (burned < cum + kc) {
      curIdx = i;
      curProgress = (burned - cum) / kc;
      curLeftKcal = cum + kc - burned;
      break;
    }
    cum += kc;
  }

  const queue = done ? 0 : eaten.length - curIdx;
  const stepsLeftTotal = Math.ceil(remaining / kcalPerStep);
  const stepsLeftCurrent = done ? 0 : Math.ceil(curLeftKcal / kcalPerStep);
  const minutesLeft = Math.ceil(stepsLeftTotal / 100); // ~100 צעדים לדקה
  const fridgeTrips = Math.ceil(stepsLeftTotal / 15); // ~15 צעדים מהסלון למקרר

  let message: string;
  if (!hasDebt) message = 'עוד לא אכלת סופגנייה היום. חשוד.';
  else if (done) message = 'הסופגנייה נעלמה מהמאזן. אפשר להתחיל סבב חדש בלב שלם.';
  else if (queue > 1) message = `יש לך ${queue} סופגניות בתור. זה כבר לא חטיף, זה פרויקט.`;
  else if (curProgress < 0.25) message = 'הסופגנייה עדיין מרגישה בבית. קדימה, לזוז!';
  else if (curProgress < 0.5) message = 'הריבה כבר מתחילה לארוז מזוודות.';
  else if (curProgress < 0.75) message = 'חצי מאחוריך. אבקת הסוכר כבר מתפזרת ברוח.';
  else message = 'עוד קצת! כבר מריחים שמן חדש במטבח.';

  const funFact = done
    ? 'טיפ: לפני הסופגנייה הבאה, כדאי לשמור מקום לעוד סבב הליכה.'
    : `≈ ${minutesLeft} דק׳ הליכה, או ${fmt(fridgeTrips)} הליכות מהסלון למקרר (בלי לפתוח אותו).`;

  return {
    hasDebt,
    done,
    totalKcal: total,
    burnedKcal: burned,
    remainingKcal: remaining,
    stepsLeftTotal,
    stepsLeftCurrent,
    currentProgress: done ? 1 : Math.min(1, Math.max(0, curProgress)),
    queue,
    minutesLeft,
    fridgeTrips,
    message,
    funFact,
  };
}

export function fmt(n: number): string {
  return Math.max(0, Math.round(n)).toLocaleString('he-IL');
}
