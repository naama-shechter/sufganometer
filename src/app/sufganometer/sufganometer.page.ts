import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { IonContent } from '@ionic/angular/standalone';
import { PedometerService, SensorState } from './pedometer.service';
import { DONUT_TYPES, fmt } from './donut-calc';

const RING_CIRCUMFERENCE = 703.7; // 2π·112

const SENSOR_LABELS: Record<SensorState, string> = {
  checking: 'בודק חיישן…',
  'needs-permission': 'לא מחובר',
  denied: 'אין הרשאה',
  unsupported: 'אין חיישן צעדים',
  live: 'מחובר למד הצעדים',
  web: 'דפדפן · הדמיה',
  error: 'שגיאה בחיישן',
};

@Component({
  selector: 'app-sufganometer',
  standalone: true,
  imports: [IonContent],
  templateUrl: './sufganometer.page.html',
  styleUrls: ['./sufganometer.page.scss'],
})
export class SufganometerPage implements OnInit {
  readonly pedo = inject(PedometerService);
  readonly types = DONUT_TYPES;
  readonly picked = signal('jam');
  readonly fmt = fmt;

  readonly s = this.pedo.status;
  readonly sensorLabel = computed(() => SENSOR_LABELS[this.pedo.sensor()]);
  readonly showConnect = computed(() => ['needs-permission', 'denied'].includes(this.pedo.sensor()));
  readonly ringOffset = computed(() => RING_CIRCUMFERENCE * (1 - this.s().currentProgress));
  readonly donutTransform = computed(() => {
    const st = this.s();
    const scale = !st.hasDebt ? 1 : st.done ? 0.0001 : Math.max(0.18, 1 - st.currentProgress * 0.82);
    return `translate(130 136) scale(${scale})`;
  });
  readonly mouthPath = computed(() =>
    this.s().currentProgress < 0.5 || !this.s().hasDebt ? 'M-14 14 Q0 26 14 14' : 'M-14 20 Q0 10 14 20',
  );
  readonly queueLabel = computed(() => {
    const q = this.s().queue;
    return q === 1 ? 'סופגנייה 1' : `${q} סופגניות`;
  });

  readonly ringLabel = computed(() =>
    this.s().hasDebt ? `נשרפו ${Math.round(this.s().currentProgress * 100)} אחוז מהסופגנייה הנוכחית` : 'אין סופגנייה פתוחה',
  );

  readonly ringCircumference = RING_CIRCUMFERENCE;

  ngOnInit(): void {
    void this.pedo.init();
  }

  eat(): void {
    const type = this.types.find((t) => t.id === this.picked());
    if (type) this.pedo.eat(type);
  }
}
