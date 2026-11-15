import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./sufganometer/sufganometer.page').then((m) => m.SufganometerPage),
  },
];
